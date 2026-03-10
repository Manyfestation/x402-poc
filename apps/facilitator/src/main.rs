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
const SCHEME_NAME: &str = "exact-kaspa-address-v0";
const TX_FORMAT: &str = "kaspa-unsigned-transaction-v1";
const NETWORK_LABEL: &str = "kaspa:testnet-12";
const QUOTE_TTL_MINUTES: i64 = 5;
const CONNECT_TIMEOUT_MS: u64 = 15_000;
const VERIFY_ATTEMPTS: usize = 20;
const VERIFY_DELAY_MS: u64 = 250;

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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaymentRequirement {
    scheme: String,
    network: String,
    payment_id: String,
    resource: String,
    merchant_address: String,
    amount_sompi: u64,
    max_fee_sompi: u64,
    facilitator_url: String,
    expires_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Quote {
    scheme: String,
    tx_format: String,
    quote_id: String,
    requirement: PaymentRequirement,
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
struct Receipt {
    scheme: String,
    payment_id: String,
    quote_id: String,
    txid: String,
    payer_address: String,
    merchant_address: String,
    amount_sompi: u64,
    fee_sompi: u64,
    status: String,
    accepted_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaymentRecord {
    status: String,
    payment_id: String,
    requirement: PaymentRequirement,
    receipt: Receipt,
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
    scheme: String,
    network: String,
    facilitator_url: String,
    wrpc_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoteRequest {
    requirement: PaymentRequirement,
    #[serde(default)]
    payer_address: Option<String>,
    #[serde(default)]
    payer_addresses: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitRequest {
    quote_id: String,
    #[serde(default)]
    txid: Option<String>,
    #[serde(default)]
    signed_transaction: Option<String>,
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
        .route("/quotes", post(create_quote))
        .route("/submit", post(submit_quote))
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
            let persisted: PersistedPayments = serde_json::from_str(&raw)?;
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
        scheme: SCHEME_NAME.to_string(),
        network: NETWORK_LABEL.to_string(),
        facilitator_url: state.facilitator_url,
        wrpc_url: state.wrpc_url,
    })
}

async fn create_quote(
    State(state): State<AppState>,
    Json(request): Json<QuoteRequest>,
) -> Result<Json<Quote>, FacilitatorError> {
    validate_requirement(&state, &request.requirement)?;
    let merchant_address = parse_address(&request.requirement.merchant_address)?;
    let payer_addresses = collect_candidate_payer_addresses(&request)?;
    let (payer_address, pending) =
        build_pending_transaction(&state, &payer_addresses, &merchant_address, request.requirement.amount_sompi).await?;
    let signing_summary = summarize_pending_transaction(state.network_id, &pending, &payer_address, &merchant_address)?;
    if signing_summary.transfer_amount_sompi != request.requirement.amount_sompi {
        return Err(FacilitatorError::message("quote merchant output amount mismatch"));
    }
    if signing_summary.fee_sompi > request.requirement.max_fee_sompi {
        return Err(FacilitatorError::message("quote fee exceeds the payment requirement max fee"));
    }

    let created_at = iso_now();
    let expires_at = quote_expires_at(&request.requirement.expires_at)?;
    let quote = Quote {
        scheme: SCHEME_NAME.to_string(),
        tx_format: TX_FORMAT.to_string(),
        quote_id: next_quote_id(&state),
        requirement: request.requirement,
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

async fn submit_quote(
    State(state): State<AppState>,
    Json(request): Json<SubmitRequest>,
) -> Result<Json<Receipt>, FacilitatorError> {
    let quote = {
        let quotes = state.quotes.lock().await;
        quotes
            .get(&request.quote_id)
            .cloned()
            .ok_or_else(|| FacilitatorError::message("unknown quote id"))?
    };

    if Utc::now() >= parse_timestamp(&quote.expires_at)? {
        return Err(FacilitatorError::message("quote has expired"));
    }

    let txid = match (request.signed_transaction.as_deref(), request.txid.as_deref()) {
        (Some(signed_transaction), _) => submit_signed_bundle(&state, signed_transaction).await?,
        (None, Some(txid)) if !txid.trim().is_empty() => txid.to_string(),
        _ => return Err(FacilitatorError::message("signedTransaction or txid is required")),
    };

    let accepted = verify_merchant_output(
        &state,
        &quote.requirement.merchant_address,
        quote.requirement.amount_sompi,
        &txid,
    )
    .await?;
    if !accepted {
        return Err(FacilitatorError::message(
            "facilitator could not verify the merchant output on TN12",
        ));
    }

    let receipt = Receipt {
        scheme: SCHEME_NAME.to_string(),
        payment_id: quote.requirement.payment_id.clone(),
        quote_id: quote.quote_id,
        txid,
        payer_address: quote.payer_context.payer_address.clone(),
        merchant_address: quote.requirement.merchant_address.clone(),
        amount_sompi: quote.requirement.amount_sompi,
        fee_sompi: quote.signing_summary.fee_sompi,
        status: "accepted".to_string(),
        accepted_at: iso_now(),
    };
    let payment = PaymentRecord {
        status: "accepted".to_string(),
        payment_id: receipt.payment_id.clone(),
        requirement: quote.requirement,
        receipt: receipt.clone(),
    };

    let mut payments = state.payments.lock().await;
    payments.insert(payment.payment_id.clone(), payment);
    persist_payments(&state.state_file, &payments)?;

    Ok(Json(receipt))
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

fn validate_requirement(state: &AppState, requirement: &PaymentRequirement) -> Result<(), FacilitatorError> {
    if requirement.scheme != SCHEME_NAME {
        return Err(FacilitatorError::message(format!(
            "unsupported scheme: {}",
            requirement.scheme
        )));
    }
    if requirement.network != NETWORK_LABEL {
        return Err(FacilitatorError::message("payment requirement uses an unexpected network"));
    }
    if requirement.facilitator_url != state.facilitator_url {
        return Err(FacilitatorError::message(
            "payment requirement points to a different facilitator",
        ));
    }
    if Utc::now() >= parse_timestamp(&requirement.expires_at)? {
        return Err(FacilitatorError::message("payment requirement has expired"));
    }

    Ok(())
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

fn collect_candidate_payer_addresses(request: &QuoteRequest) -> Result<Vec<Address>, FacilitatorError> {
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

fn quote_expires_at(requirement_expires_at: &str) -> Result<String, FacilitatorError> {
    let limit = Utc::now() + ChronoDuration::minutes(QUOTE_TTL_MINUTES);
    let requirement_expiry = parse_timestamp(requirement_expires_at)?;
    Ok(std::cmp::min(requirement_expiry, limit).to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
