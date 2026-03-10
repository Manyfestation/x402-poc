import { spawn } from "node:child_process";
import net from "node:net";

const processes = [];
let shuttingDown = false;

async function assertPortAvailable(port, name) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        reject(new Error(`${name} cannot start: port ${port} is already in use`));
        return;
      }
      reject(error);
    });

    server.once("listening", () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    server.listen(port, "127.0.0.1");
  });
}

function prefixStream(stream, prefix, target) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      target.write(`[${prefix}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer) {
      target.write(`[${prefix}] ${buffer}\n`);
    }
  });
}

function spawnService(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"]
  });

  prefixStream(child.stdout, name, process.stdout);
  prefixStream(child.stderr, name, process.stderr);

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[runner] ${name} exited unexpectedly with ${reason}`);
    shutdown(code ?? 1);
  });

  processes.push({ name, child });
  return child;
}

async function waitForHttp(url, { name, validate, timeoutMs = 60_000, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "service did not respond";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (validate(response)) {
        console.log(`[runner] ${name} ready at ${url}`);
        return;
      }
      lastError = `unexpected status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${name} did not become ready: ${lastError}`);
}

function terminate(child) {
  if (child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 5_000);
  child.once("exit", () => clearTimeout(timer));
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const { child } of processes) {
    terminate(child);
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 100);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  console.log("[runner] starting facilitator, merchant, and ui");

  await assertPortAvailable(4021, "facilitator");
  await assertPortAvailable(4022, "merchant");
  await assertPortAvailable(4023, "ui");

  spawnService("facilitator", "npm", ["run", "facilitator"]);
  await waitForHttp("http://127.0.0.1:4021/health", {
    name: "facilitator",
    validate: (response) => response.ok
  });

  spawnService("merchant", "npm", ["run", "merchant"]);
  await waitForHttp("http://127.0.0.1:4022/premium", {
    name: "merchant",
    validate: (response) => response.status === 402
  });

  spawnService("ui", "npm", ["run", "ui"]);
  await waitForHttp("http://127.0.0.1:4023/", {
    name: "ui",
    validate: (response) => response.ok
  });

  console.log("[runner] all services are up");
  console.log("[runner] ui: http://127.0.0.1:4023");
}

main().catch((error) => {
  console.error(`[runner] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});
