use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use kaspa_addresses::{Address, Prefix};
use kaspa_consensus_core::network::{NetworkId, NetworkType};
use kaspa_consensus_core::tx::{TransactionInput, UtxoEntry, VerifiableTransaction};
use kaspa_rpc_core::{RpcUtxosByAddressesEntry, api::rpc::RpcApi};
use kaspa_txscript::extract_script_pub_key_address;
use kaspa_wallet_core::account::pskb::finalize_pskt_one_or_more_sig_and_redeem_script;
use kaspa_wallet_core::tx::{Generator, GeneratorSettings, PaymentDestination, PaymentOutputs, PendingTransaction};
use kaspa_wallet_pskt::bundle::Bundle;
use kaspa_wallet_pskt::prelude::{Inner as PsktInner, Signer as PsktSigner};
use kaspa_wallet_pskt::pskt::PSKT;
use kaspa_wrpc_client::{
    KaspaRpcClient, WrpcEncoding,
    client::{ConnectOptions, ConnectStrategy},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::fs::{create_dir_all, read_to_string, write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};

const DEFAULT_PORT: u16 = 4021;
const DEFAULT_WRPC_URL: &str = "wss://tn12reset-wrpc.kasia.fyi";
const DEFAULT_STATE_FILE: &str = "apps/facilitator/.data/facilitator-state.json";
const X402_VERSION: u64 = 2;
const SCHEME_NAME: &str = "exact";
const TX_FORMAT: &str = "kaspa-unsigned-transaction-v1";
const NETWORK_LABEL: &str = "kaspa:testnet-12";
const ASSET_ID: &str = "kaspa:testnet-12/slip44:111111";
const QUOTE_TTL_MINUTES: i64 = 5;
const CONNECT_TIMEOUT_MS: u64 = 15_000;
const VERIFY_ATTEMPTS: usize = 20;
const VERIFY_DELAY_MS: u64 = 250;
const PAYMENT_IDENTIFIER_EXTENSION: &str = "payment-identifier";

#[derive(Clone)]
struct AppState {
    network_id: NetworkId,
    wrpc_url: String,
    facilitator_url: String,
    rpc: Arc<KaspaRpcClient>,
    state_file: PathBuf,
    quotes: Arc<Mutex<HashMap<String, Quote>>>,
    payments: Arc<Mutex<HashMap<String, PaymentRecord>>>,
    quote_counter: Arc<AtomicU64>,
}

#[derive(Debug)]
enum FacilitatorError {
    Message(String),
}

impl FacilitatorError {
    fn message(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

impl Display for FacilitatorError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for FacilitatorError {}

impl IntoResponse for FacilitatorError {
    fn into_response(self) -> Response {
        let body = Json(serde_json::json!({ "error": self.to_string() }));
        (StatusCode::BAD_REQUEST, body).into_response()
    }
}

impl From<std::io::Error> for FacilitatorError {
    fn from(value: std::io::Error) -> Self {
        Self::message(value.to_string())
    }
}

impl From<serde_json::Error> for FacilitatorError {
    fn from(value: serde_json::Error) -> Self {
        Self::message(value.to_string())
    }
}

impl From<chrono::ParseError> for FacilitatorError {
    fn from(value: chrono::ParseError) -> Self {
        Self::message(value.to_string())
    }
}

impl From<kaspa_wallet_core::error::Error> for FacilitatorError {
    fn from(value: kaspa_wallet_core::error::Error) -> Self {
        Self::message(value.to_string())
    }
}

impl From<kaspa_wallet_pskt::error::Error> for FacilitatorError {
    fn from(value: kaspa_wallet_pskt::error::Error) -> Self {
        Self::message(value.to_string())
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PaymentRequirements {
    scheme: String,
    network: String,
    amount: String,
    asset: String,
    pay_to: String,
    max_timeout_seconds: u64,
    #[serde(default)]
    extra: KaspaRequirementsExtra,
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct KaspaRequirementsExtra {
    #[serde(default)]
    max_fee_sompi: u64,
    #[serde(default)]
    tx_format: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Quote {
    x402_version: u64,
    scheme: String,
    tx_format: String,
    quote_id: String,
    payment_requirements: PaymentRequirements,
    unsigned_transaction: String,
    signing_summary: SigningSummary,
    payer_context: PayerContext,
    created_at: String,
    expires_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PayerContext {
    payer_address: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaymentRecord {
    status: String,
    payment_id: String,
    payment_payload: PaymentPayload,
    payment_requirements: PaymentRequirements,
    settlement_response: SettlementResponse,
    accepted_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingPaymentResponse {
    status: String,
    payment_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    x402_version: u64,
    scheme: String,
    network: String,
    asset: String,
    facilitator_url: String,
    wrpc_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareRequest {
    payment_requirements: PaymentRequirements,
    #[serde(default)]
    payer_address: Option<String>,
    #[serde(default)]
    payer_addresses: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRequest {
    x402_version: u64,
    payment_payload: PaymentPayload,
    payment_requirements: PaymentRequirements,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyResponse {
    is_valid: bool,
    #[serde(default)]
    invalid_reason: Option<String>,
    #[serde(default)]
    payer: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SigningSummary {
    payer_address: String,
    merchant_address: String,
    selected_inputs: Vec<SelectedInput>,
    total_input_sompi: u64,
    transfer_amount_sompi: u64,
    change_address: String,
    change_amount_sompi: u64,
    fee_sompi: u64,
    tx_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedInput {
    outpoint: String,
    address: String,
    amount_sompi: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceInfo {
    url: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    mime_type: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionValue {
    #[serde(default)]
    info: Value,
    #[serde(default)]
    schema: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaymentPayloadData {
    quote_id: String,
    transaction: String,
    #[serde(default)]
    tx_format: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaymentPayload {
    x402_version: u64,
    #[serde(default)]
    resource: Option<ResourceInfo>,
    accepted: PaymentRequirements,
    payload: PaymentPayloadData,
    #[serde(default)]
    extensions: HashMap<String, ExtensionValue>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SettlementResponse {
    success: bool,
    #[serde(default)]
    error_reason: Option<String>,
    #[serde(default)]
    payer: Option<String>,
    transaction: String,
    network: String,
    #[serde(default)]
    extensions: HashMap<String, ExtensionValue>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportedKind {
    x402_version: u64,
    scheme: String,
    network: String,
    extra: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportedResponse {
    kinds: Vec<SupportedKind>,
    extensions: Vec<String>,
    signers: HashMap<String, Vec<String>>,
}

#[derive(Deserialize, Serialize)]
struct PersistedPayments {
    payments: Vec<PaymentRecord>,
}

#[tokio::main]
async fn main() -> Result<(), FacilitatorError> {
    let port = std::env::var("FACILITATOR_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    let wrpc_url = std::env::var("X402_KASPA_WRPC_URL").unwrap_or_else(|_| DEFAULT_WRPC_URL.to_string());
    let facilitator_url =
        std::env::var("X402_FACILITATOR_URL").unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
    let state_file =
        PathBuf::from(std::env::var("X402_FACILITATOR_STATE_FILE").unwrap_or_else(|_| DEFAULT_STATE_FILE.to_string()));
    let network_id = NetworkId::with_suffix(NetworkType::Testnet, 12);
    let rpc = connect_rpc(&wrpc_url, network_id).await?;
    let payments = load_payments(&state_file)?;

    let state = AppState {
        network_id,
        wrpc_url,
        facilitator_url,
        rpc,
        state_file,
        quotes: Arc::new(Mutex::new(HashMap::new())),
        payments: Arc::new(Mutex::new(payments)),
        quote_counter: Arc::new(AtomicU64::new(0)),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(health))
        .route("/v2/x402/supported", get(supported))
        .route("/v2/x402/prepare", post(prepare_payment))
        .route("/v2/x402/verify", post(verify_payment))
        .route("/v2/x402/settle", post(settle_payment))
        .route("/payments/:payment_id", get(get_payment))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| FacilitatorError::message(error.to_string()))?;
    println!(
        "facilitator listening on http://{}",
        listener
            .local_addr()
            .map_err(|error| FacilitatorError::message(error.to_string()))?
    );
    axum::serve(listener, app).await.map_err(|error| FacilitatorError::message(error.to_string()))
}

async fn connect_rpc(wrpc_url: &str, network_id: NetworkId) -> Result<Arc<KaspaRpcClient>, FacilitatorError> {
    let client = Arc::new(
        KaspaRpcClient::new(WrpcEncoding::Borsh, Some(wrpc_url), None, Some(network_id), None)
            .map_err(|error| FacilitatorError::message(error.to_string()))?,
    );
    let options = ConnectOptions {
        block_async_connect: true,
        connect_timeout: Some(Duration::from_millis(CONNECT_TIMEOUT_MS)),
        strategy: ConnectStrategy::Fallback,
        url: Some(wrpc_url.to_string()),
        ..Default::default()
    };
    client
        .connect(Some(options))
        .await
        .map_err(|error| FacilitatorError::message(error.to_string()))?;
    let info = client
        .get_server_info()
        .await
        .map_err(|error| FacilitatorError::message(error.to_string()))?;
    if !info.is_synced {
        return Err(FacilitatorError::message("public testnet-12 RPC is not synced yet"));
    }
    if !info.has_utxo_index {
        return Err(FacilitatorError::message("public testnet-12 RPC does not have a UTXO index"));
    }

    Ok(client)
}

fn load_payments(state_file: &PathBuf) -> Result<HashMap<String, PaymentRecord>, FacilitatorError> {
    match read_to_string(state_file) {
        Ok(raw) => {
            let persisted = match serde_json::from_str::<PersistedPayments>(&raw) {
                Ok(persisted) => persisted,
                Err(_) => return Ok(HashMap::new()),
            };
            Ok(persisted
                .payments
                .into_iter()
                .map(|payment| (payment.payment_id.clone(), payment))
                .collect())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

fn persist_payments(state_file: &PathBuf, payments: &HashMap<String, PaymentRecord>) -> Result<(), FacilitatorError> {
    if let Some(parent) = state_file.parent() {
        create_dir_all(parent)?;
    }
    let payload = PersistedPayments {
        payments: payments.values().cloned().collect(),
    };
    write(state_file, serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        x402_version: X402_VERSION,
        scheme: SCHEME_NAME.to_string(),
        network: NETWORK_LABEL.to_string(),
        asset: ASSET_ID.to_string(),
        facilitator_url: state.facilitator_url,
        wrpc_url: state.wrpc_url,
    })
}

async fn supported() -> Json<SupportedResponse> {
    let mut signers = HashMap::new();
    signers.insert("kaspa:*".to_string(), Vec::new());

    Json(SupportedResponse {
        kinds: vec![SupportedKind {
            x402_version: X402_VERSION,
            scheme: SCHEME_NAME.to_string(),
            network: NETWORK_LABEL.to_string(),
            extra: json!({
                "asset": ASSET_ID,
                "txFormat": TX_FORMAT
            }),
        }],
        extensions: vec![PAYMENT_IDENTIFIER_EXTENSION.to_string()],
        signers,
    })
}

async fn prepare_payment(
    State(state): State<AppState>,
    Json(request): Json<PrepareRequest>,
) -> Result<Json<Quote>, FacilitatorError> {
    validate_payment_requirements(&state, &request.payment_requirements)?;
    let merchant_address = parse_address(&request.payment_requirements.pay_to)?;
    let payer_addresses = collect_candidate_payer_addresses(&request)?;
    let amount_sompi = parse_amount_sompi(&request.payment_requirements.amount)?;
    let (payer_address, pending) =
        build_pending_transaction(&state, &payer_addresses, &merchant_address, amount_sompi).await?;
    let signing_summary = summarize_pending_transaction(state.network_id, &pending, &payer_address, &merchant_address)?;
    if signing_summary.transfer_amount_sompi != amount_sompi {
        return Err(FacilitatorError::message("quote merchant output amount mismatch"));
    }
    if signing_summary.fee_sompi > request.payment_requirements.extra.max_fee_sompi {
        return Err(FacilitatorError::message("quote fee exceeds the payment requirement max fee"));
    }

    let created_at = iso_now();
    let expires_at = quote_expires_at(request.payment_requirements.max_timeout_seconds);
    let quote = Quote {
        x402_version: X402_VERSION,
        scheme: SCHEME_NAME.to_string(),
        tx_format: TX_FORMAT.to_string(),
        quote_id: next_quote_id(&state),
        payment_requirements: request.payment_requirements,
        unsigned_transaction: bundle_from_pending_transaction(&pending)?.serialize()?,
        signing_summary,
        payer_context: PayerContext {
            payer_address: payer_address.to_string(),
        },
        created_at,
        expires_at,
    };

    state.quotes.lock().await.insert(quote.quote_id.clone(), quote.clone());
    Ok(Json(quote))
}

async fn verify_payment(
    State(state): State<AppState>,
    Json(request): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, FacilitatorError> {
    Ok(Json(run_verify(&state, &request).await?))
}

async fn settle_payment(
    State(state): State<AppState>,
    Json(request): Json<VerifyRequest>,
) -> Result<Json<SettlementResponse>, FacilitatorError> {
    let verification = run_verify(&state, &request).await?;
    if !verification.is_valid {
        return Ok(Json(failed_settlement_response(
            &request.payment_payload,
            &request.payment_requirements,
            verification.invalid_reason.as_deref().unwrap_or("invalid_payment"),
            verification.payer,
        )));
    }

    let quote = load_quote(&state, &request.payment_payload.payload.quote_id).await?;
    let payment_id = payment_id_from_payload(&request.payment_payload)
        .unwrap_or_else(|| format!("payment_{}", quote.quote_id.replace("quote_", "")));

    if let Some(existing) = state.payments.lock().await.get(&payment_id).cloned() {
        return Ok(Json(existing.settlement_response));
    }

    let txid = submit_signed_bundle(&state, &request.payment_payload.payload.transaction).await?;
    let accepted = verify_merchant_output(
        &state,
        &request.payment_requirements.pay_to,
        parse_amount_sompi(&request.payment_requirements.amount)?,
        &txid,
    )
    .await?;
    if !accepted {
        return Ok(Json(failed_settlement_response(
            &request.payment_payload,
            &request.payment_requirements,
            "merchant_output_unverified",
            Some(quote.payer_context.payer_address.clone()),
        )));
    }

    let settlement_response = SettlementResponse {
        success: true,
        error_reason: None,
        payer: Some(quote.payer_context.payer_address.clone()),
        transaction: txid,
        network: NETWORK_LABEL.to_string(),
        extensions: request.payment_payload.extensions.clone(),
    };
    let payment = PaymentRecord {
        status: "accepted".to_string(),
        payment_id: payment_id.clone(),
        payment_payload: request.payment_payload,
        payment_requirements: request.payment_requirements,
        settlement_response: settlement_response.clone(),
        accepted_at: iso_now(),
    };

    let mut payments = state.payments.lock().await;
    payments.insert(payment_id, payment);
    persist_payments(&state.state_file, &payments)?;

    Ok(Json(settlement_response))
}

async fn get_payment(
    State(state): State<AppState>,
    Path(payment_id): Path<String>,
) -> Result<Response, FacilitatorError> {
    let payments = state.payments.lock().await;
    if let Some(payment) = payments.get(&payment_id) {
        return Ok(Json(payment.clone()).into_response());
    }

    Ok(Json(PendingPaymentResponse {
        status: "pending".to_string(),
        payment_id,
    })
    .into_response())
}

fn validate_payment_requirements(_state: &AppState, requirement: &PaymentRequirements) -> Result<(), FacilitatorError> {
    if requirement.scheme != SCHEME_NAME {
        return Err(FacilitatorError::message(format!(
            "unsupported scheme: {}",
            requirement.scheme
        )));
    }
    if requirement.network != NETWORK_LABEL {
        return Err(FacilitatorError::message("payment requirements use an unexpected network"));
    }
    if requirement.asset != ASSET_ID {
        return Err(FacilitatorError::message(
            "payment requirements use an unexpected asset",
        ));
    }
    if requirement.max_timeout_seconds == 0 {
        return Err(FacilitatorError::message("payment requirements maxTimeoutSeconds must be positive"));
    }
    if !requirement.extra.tx_format.is_empty() && requirement.extra.tx_format != TX_FORMAT {
        return Err(FacilitatorError::message("payment requirements use an unsupported tx format"));
    }
    parse_amount_sompi(&requirement.amount)?;

    Ok(())
}

fn failed_settlement_response(
    payment_payload: &PaymentPayload,
    payment_requirements: &PaymentRequirements,
    error_reason: &str,
    payer: Option<String>,
) -> SettlementResponse {
    SettlementResponse {
        success: false,
        error_reason: Some(error_reason.to_string()),
        payer,
        transaction: String::new(),
        network: payment_requirements.network.clone(),
        extensions: payment_payload.extensions.clone(),
    }
}

fn invalid_verify_response(reason: impl Into<String>, payer: Option<String>) -> VerifyResponse {
    VerifyResponse {
        is_valid: false,
        invalid_reason: Some(reason.into()),
        payer,
    }
}

fn valid_verify_response(payer: Option<String>) -> VerifyResponse {
    VerifyResponse {
        is_valid: true,
        invalid_reason: None,
        payer,
    }
}

async fn load_quote(state: &AppState, quote_id: &str) -> Result<Quote, FacilitatorError> {
    let quote = {
        let quotes = state.quotes.lock().await;
        quotes
            .get(quote_id)
            .cloned()
            .ok_or_else(|| FacilitatorError::message("unknown quote id"))?
    };

    if Utc::now() >= parse_timestamp(&quote.expires_at)? {
        return Err(FacilitatorError::message("quote has expired"));
    }

    Ok(quote)
}

async fn run_verify(state: &AppState, request: &VerifyRequest) -> Result<VerifyResponse, FacilitatorError> {
    if request.x402_version != X402_VERSION || request.payment_payload.x402_version != X402_VERSION {
        return Err(FacilitatorError::message("x402Version must be 2"));
    }
    validate_payment_requirements(state, &request.payment_requirements)?;

    if request.payment_payload.accepted != request.payment_requirements {
        return Ok(invalid_verify_response(
            "accepted_payment_requirements_mismatch",
            None,
        ));
    }

    if request.payment_payload.payload.quote_id.trim().is_empty() {
        return Ok(invalid_verify_response("missing_quote_id", None));
    }

    if request.payment_payload.payload.transaction.trim().is_empty() {
        return Ok(invalid_verify_response("missing_transaction", None));
    }

    let tx_format = request
        .payment_payload
        .payload
        .tx_format
        .as_deref()
        .unwrap_or(TX_FORMAT);
    if tx_format != TX_FORMAT {
        return Ok(invalid_verify_response("unsupported_tx_format", None));
    }

    let quote = match load_quote(state, &request.payment_payload.payload.quote_id).await {
        Ok(quote) => quote,
        Err(error) => return Ok(invalid_verify_response(error.to_string(), None)),
    };

    if quote.payment_requirements != request.payment_requirements {
        return Ok(invalid_verify_response(
            "quote_payment_requirements_mismatch",
            Some(quote.payer_context.payer_address),
        ));
    }

    match inspect_signed_bundle_against_quote(
        state.network_id,
        &request.payment_payload.payload.transaction,
        &quote,
        &request.payment_requirements,
    ) {
        Ok(()) => Ok(valid_verify_response(Some(quote.payer_context.payer_address))),
        Err(error) => Ok(invalid_verify_response(
            error.to_string(),
            Some(quote.payer_context.payer_address),
        )),
    }
}

fn payment_id_from_payload(payment_payload: &PaymentPayload) -> Option<String> {
    payment_payload
        .extensions
        .get(PAYMENT_IDENTIFIER_EXTENSION)
        .and_then(|entry| entry.info.get("paymentId"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
}

fn parse_amount_sompi(value: &str) -> Result<u64, FacilitatorError> {
    value
        .parse::<u64>()
        .map_err(|_| FacilitatorError::message(format!("invalid amount: {value}")))
}

async fn build_pending_transaction(
    state: &AppState,
    payer_addresses: &[Address],
    merchant_address: &Address,
    amount_sompi: u64,
) -> Result<(Address, PendingTransaction), FacilitatorError> {
    let mut first_candidate = None;

    for payer_address in payer_addresses {
        if first_candidate.is_none() {
            first_candidate = Some(payer_address.to_string());
        }
        let rpc_utxos = state
            .rpc
            .get_utxos_by_addresses(vec![payer_address.clone()])
            .await
            .map_err(|error| FacilitatorError::message(error.to_string()))?;
        if rpc_utxos.is_empty() {
            continue;
        }

        let utxo_iterator = build_utxo_iterator(rpc_utxos);
        let settings = GeneratorSettings::try_new_with_iterator(
            state.network_id,
            utxo_iterator,
            None,
            payer_address.clone(),
            1,
            1,
            PaymentDestination::PaymentOutputs(PaymentOutputs::from((merchant_address.clone(), amount_sompi))),
            None,
            0u64.into(),
            None,
            None,
        )?;
        let generator = Generator::try_new(settings, None, None)?;
        let mut pending_transactions = generator
            .iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(FacilitatorError::from)?;
        if pending_transactions.is_empty() {
            return Err(FacilitatorError::message(
                "transaction generator did not produce any unsigned transactions",
            ));
        }
        if pending_transactions.len() != 1 {
            return Err(FacilitatorError::message(format!(
                "this demo expects a single transaction, received {}",
                pending_transactions.len()
            )));
        }

        return Ok((payer_address.clone(), pending_transactions.remove(0)));
    }

    Err(FacilitatorError::message(format!(
        "insufficient funds for {}",
        first_candidate.unwrap_or_else(|| "wallet".to_string())
    )))
}

fn build_utxo_iterator(
    entries: Vec<RpcUtxosByAddressesEntry>,
) -> Box<dyn Iterator<Item = kaspa_consensus_client::UtxoEntryReference> + Send + Sync + 'static> {
    Box::new(entries.into_iter().map(Into::into))
}

fn bundle_from_pending_transaction(pending: &PendingTransaction) -> Result<Bundle, FacilitatorError> {
    let signable_tx = pending.signable_transaction();
    let verifiable_tx = signable_tx.as_verifiable();
    let populated_inputs: Vec<(&TransactionInput, &UtxoEntry)> = verifiable_tx.populated_inputs().collect();
    let pskt_inner: PsktInner = PsktInner::try_from((pending.transaction(), populated_inputs.to_owned()))
        .map_err(|error| FacilitatorError::message(error.to_string()))?;
    let pskt: PSKT<PsktSigner> = PSKT::from(pskt_inner);

    Ok(Bundle::from(pskt))
}

fn summarize_pending_transaction(
    network_id: NetworkId,
    pending: &PendingTransaction,
    payer_address: &Address,
    merchant_address: &Address,
) -> Result<SigningSummary, FacilitatorError> {
    let prefix = Prefix::from(network_id);
    let mut selected_inputs = pending
        .utxo_entries()
        .values()
        .map(|entry| {
            let address = entry
                .address()
                .ok_or_else(|| FacilitatorError::message("UTXO entry is missing an address"))?;
            Ok(SelectedInput {
                outpoint: format!("{}:{}", entry.outpoint().transaction_id(), entry.outpoint().index()),
                address: address.to_string(),
                amount_sompi: entry.amount(),
            })
        })
        .collect::<Result<Vec<_>, FacilitatorError>>()?;
    selected_inputs.sort_by(|left, right| left.outpoint.cmp(&right.outpoint));

    let outputs = pending.transaction().outputs;
    let merchant_address_string = merchant_address.to_string();
    let payer_address_string = payer_address.to_string();
    let total_output_sompi = outputs.iter().map(|output| output.value).sum::<u64>();
    let mut transfer_amount_sompi = 0u64;
    let mut change_outputs = Vec::new();

    for output in outputs {
        let output_address = extract_script_pub_key_address(&output.script_public_key, prefix)
            .map_err(|error| FacilitatorError::message(error.to_string()))?;
        if output_address.to_string() == merchant_address_string {
            transfer_amount_sompi = transfer_amount_sompi.saturating_add(output.value);
        } else {
            change_outputs.push((output_address.to_string(), output.value));
        }
    }

    if transfer_amount_sompi == 0 {
        return Err(FacilitatorError::message("PSKB is missing the merchant output"));
    }
    if change_outputs.len() > 1 {
        return Err(FacilitatorError::message(
            "PSKB produced an unsupported change shape for this demo",
        ));
    }

    let (change_address, change_amount_sompi) = change_outputs
        .into_iter()
        .next()
        .unwrap_or((payer_address_string.clone(), 0));
    let total_input_sompi = pending.aggregate_input_value();
    let fee_sompi = total_input_sompi
        .checked_sub(total_output_sompi)
        .ok_or_else(|| FacilitatorError::message("PSKB output total exceeds input total"))?;

    Ok(SigningSummary {
        payer_address: payer_address_string,
        merchant_address: merchant_address_string,
        selected_inputs,
        total_input_sompi,
        transfer_amount_sompi,
        change_address,
        change_amount_sompi,
        fee_sompi,
        tx_count: 1,
    })
}

fn extract_transaction_from_signed_bundle(
    network_id: NetworkId,
    signed_transaction: &str,
) -> Result<kaspa_consensus_core::tx::Transaction, FacilitatorError> {
    let bundle = Bundle::deserialize(signed_transaction)?;
    let params = network_id.into();
    let mut transactions = Vec::new();

    for bundle_inner in bundle.iter().cloned() {
        let pskt: PSKT<PsktSigner> = PSKT::from(bundle_inner);
        let finalized = finalize_pskt_one_or_more_sig_and_redeem_script(pskt.finalizer())?;
        let extractor = finalized
            .extractor()
            .map_err(|_| FacilitatorError::message("signed PSKB is not finalized"))?;
        let transaction = extractor
            .extract_tx(&params)
            .map_err(|error| FacilitatorError::message(error.to_string()))?;
        transactions.push(transaction.tx.clone());
    }

    if transactions.len() != 1 {
        return Err(FacilitatorError::message(format!(
            "signed PSKB produced {} transactions; this demo expects one tx",
            transactions.len()
        )));
    }

    Ok(transactions.remove(0))
}

fn inspect_signed_bundle_against_quote(
    network_id: NetworkId,
    signed_transaction: &str,
    quote: &Quote,
    payment_requirements: &PaymentRequirements,
) -> Result<(), FacilitatorError> {
    let transaction = extract_transaction_from_signed_bundle(network_id, signed_transaction)?;
    let prefix = Prefix::from(network_id);
    let expected_amount = parse_amount_sompi(&payment_requirements.amount)?;

    let mut expected_outpoints = quote
        .signing_summary
        .selected_inputs
        .iter()
        .map(|input| input.outpoint.clone())
        .collect::<Vec<_>>();
    expected_outpoints.sort();

    let mut actual_outpoints = transaction
        .inputs
        .iter()
        .map(|input| format!("{}:{}", input.previous_outpoint.transaction_id, input.previous_outpoint.index))
        .collect::<Vec<_>>();
    actual_outpoints.sort();

    if actual_outpoints != expected_outpoints {
        return Err(FacilitatorError::message("signed PSKB inputs do not match the prepared quote"));
    }

    let total_input_sompi = quote
        .signing_summary
        .selected_inputs
        .iter()
        .map(|input| input.amount_sompi)
        .sum::<u64>();
    let total_output_sompi = transaction.outputs.iter().map(|output| output.value).sum::<u64>();
    let fee_sompi = total_input_sompi
        .checked_sub(total_output_sompi)
        .ok_or_else(|| FacilitatorError::message("signed PSKB output total exceeds input total"))?;
    if fee_sompi > payment_requirements.extra.max_fee_sompi {
        return Err(FacilitatorError::message("signed PSKB fee exceeds maxFeeSompi"));
    }
    if fee_sompi != quote.signing_summary.fee_sompi {
        return Err(FacilitatorError::message("signed PSKB fee does not match the prepared quote"));
    }

    let mut merchant_amount_sompi = 0u64;
    let mut change_outputs = Vec::new();
    for output in &transaction.outputs {
        let address = extract_script_pub_key_address(&output.script_public_key, prefix)
            .map_err(|error| FacilitatorError::message(error.to_string()))?;
        if address.to_string() == payment_requirements.pay_to {
            merchant_amount_sompi = merchant_amount_sompi.saturating_add(output.value);
        } else {
            change_outputs.push((address.to_string(), output.value));
        }
    }

    if merchant_amount_sompi != expected_amount {
        return Err(FacilitatorError::message("signed PSKB merchant output amount mismatch"));
    }

    if change_outputs.len() > 1 {
        return Err(FacilitatorError::message(
            "signed PSKB produced an unsupported change shape for this demo",
        ));
    }

    match change_outputs.into_iter().next() {
        Some((change_address, change_amount_sompi)) => {
            if change_address != quote.signing_summary.change_address {
                return Err(FacilitatorError::message("signed PSKB change output address mismatch"));
            }
            if change_amount_sompi != quote.signing_summary.change_amount_sompi {
                return Err(FacilitatorError::message("signed PSKB change output amount mismatch"));
            }
        }
        None if quote.signing_summary.change_amount_sompi != 0 => {
            return Err(FacilitatorError::message("signed PSKB change output is missing"));
        }
        None => {}
    }

    Ok(())
}

async fn submit_signed_bundle(state: &AppState, signed_transaction: &str) -> Result<String, FacilitatorError> {
    let bundle = Bundle::deserialize(signed_transaction)?;
    let params = state.network_id.into();
    let mut txids = Vec::new();

    for bundle_inner in bundle.iter().cloned() {
        let pskt: PSKT<PsktSigner> = PSKT::from(bundle_inner);
        let finalized = finalize_pskt_one_or_more_sig_and_redeem_script(pskt.finalizer())?;
        let extractor = finalized
            .extractor()
            .map_err(|_| FacilitatorError::message("signed PSKB is not finalized"))?;
        let transaction = extractor
            .extract_tx(&params)
            .map_err(|error| FacilitatorError::message(error.to_string()))?;
        let txid = state
            .rpc
            .submit_transaction((&transaction.tx).into(), false)
            .await
            .map_err(|error| FacilitatorError::message(error.to_string()))?;
        txids.push(txid.to_string());
    }

    if txids.len() != 1 {
        return Err(FacilitatorError::message(format!(
            "facilitator broadcast produced {} transaction ids; this demo expects one tx",
            txids.len()
        )));
    }

    Ok(txids.remove(0))
}

async fn verify_merchant_output(
    state: &AppState,
    merchant_address: &str,
    amount_sompi: u64,
    txid: &str,
) -> Result<bool, FacilitatorError> {
    let merchant_address = parse_address(merchant_address)?;
    for _ in 0..VERIFY_ATTEMPTS {
        let utxos = state
            .rpc
            .get_utxos_by_addresses(vec![merchant_address.clone()])
            .await
            .map_err(|error| FacilitatorError::message(error.to_string()))?;

        if utxos.into_iter().any(|entry| {
            entry.outpoint.transaction_id.to_string() == txid && entry.utxo_entry.amount == amount_sompi
        }) {
            return Ok(true);
        }

        sleep(Duration::from_millis(VERIFY_DELAY_MS)).await;
    }

    Ok(false)
}

fn parse_address(value: &str) -> Result<Address, FacilitatorError> {
    Address::try_from(value).map_err(|error| FacilitatorError::message(error.to_string()))
}

fn collect_candidate_payer_addresses(request: &PrepareRequest) -> Result<Vec<Address>, FacilitatorError> {
    let mut addresses = Vec::new();

    if let Some(primary) = request.payer_address.as_ref() {
        if !primary.trim().is_empty() {
            addresses.push(primary.clone());
        }
    }

    for address in &request.payer_addresses {
        if !address.trim().is_empty() && !addresses.contains(address) {
            addresses.push(address.clone());
        }
    }

    if addresses.is_empty() {
        return Err(FacilitatorError::message("payerAddress or payerAddresses is required"));
    }

    addresses.into_iter().map(|value| parse_address(&value)).collect()
}

fn next_quote_id(state: &AppState) -> String {
    let counter = state.quote_counter.fetch_add(1, Ordering::Relaxed) + 1;
    format!("quote_{:016x}", counter)
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, FacilitatorError> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

fn quote_expires_at(max_timeout_seconds: u64) -> String {
    let max_quote_timeout = ChronoDuration::minutes(QUOTE_TTL_MINUTES);
    let requested_timeout = ChronoDuration::seconds(max_timeout_seconds as i64);
    (Utc::now() + std::cmp::min(max_quote_timeout, requested_timeout))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
