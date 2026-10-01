import WebSocket from "ws";
import { config, AssetConfig } from "./config";
import { sendAlert } from "./telegram";
import { getUsdPrice } from "./price";

interface FlatEvents {
  [key: string]: string[];
}

function first(events: FlatEvents, key: string): string | undefined {
  return events[key]?.[0];
}

function parseAmount(raw: string, denom: string): string | null {
  // Pure digits - denom comes from separate field
  if (/^\d+$/.test(raw)) {
    return raw;
  }

  // Combined string like "500000uzig"
  if (raw.includes(denom)) {
    const amountPart = raw.replace(denom, "").trim();
    if (/^\d+$/.test(amountPart)) {
      return amountPart;
    }
  }

  return null;
}

interface Candidate {
  sender: string;
  recipient: string;
  amountRaw: string;
}

/**
 * A single tx packs MANY transfer events into parallel arrays — e.g. one
 * event for the gas fee, plus one or more for the actual message being
 * executed. transfer.sender[i], transfer.recipient[i], and
 * transfer.amount[i] line up by index. Reading only index [0] (as the
 * earlier version did) means we only ever see the gas fee transfer, since
 * it's almost always emitted first. We need to scan every index.
 */
function collectCandidates(events: FlatEvents, denom: string): Candidate[] {
  const senders = events["transfer.sender"] ?? [];
  const recipients = events["transfer.recipient"] ?? [];
  const amounts = events["transfer.amount"] ?? [];

  const len = Math.max(senders.length, recipients.length, amounts.length);
  const candidates: Candidate[] = [];

  for (let i = 0; i < len; i++) {
    const sender = senders[i];
    const recipient = recipients[i];
    const rawAmount = amounts[i];
    if (!sender || !recipient || !rawAmount) continue;

    const amountRaw = parseAmount(rawAmount, denom);
    if (!amountRaw) continue;

    candidates.push({ sender, recipient, amountRaw });
  }

  return candidates;
}

async function checkAsset(asset: AssetConfig, events: FlatEvents, txHash: string): Promise<void> {
  const candidates = collectCandidates(events, asset.denom);
  if (candidates.length === 0) return;

  console.log(`  Found ${candidates.length} ${asset.symbol} transfer event(s) in this tx`);

  // A tx can legitimately contain multiple qualifying transfers (e.g.
  // multi-send). Check each one independently against the threshold.
  for (const { sender, recipient, amountRaw } of candidates) {
    const humanAmount = parseFloat(amountRaw) / Math.pow(10, asset.decimals);

    console.log(
      `    ${sender.slice(0, 12)}... -> ${recipient.slice(0, 12)}...  ` +
      `${humanAmount.toLocaleString()} ${asset.symbol} (threshold: ${asset.minThreshold})`
    );

    if (humanAmount < asset.minThreshold) {
      continue;
    }

    console.log(`    ✅ THRESHOLD MET - SENDING ALERT (${asset.symbol})`);
    const usdPrice = asset.coingeckoId ? await getUsdPrice(asset.coingeckoId) : null;
    await sendAlert(
      asset.symbol,
      asset.displayDenom,
      humanAmount,
      amountRaw,
      sender,
      recipient,
      txHash,
      usdPrice,
      asset.coingeckoId !== null
    );
  }
}

async function processFlatEvents(events: FlatEvents): Promise<void> {
  const txHash = first(events, "tx.hash");
  if (!txHash) return;

  console.log(`\n[PROCESSING] TX: ${txHash}`);

  for (const asset of config.assets) {
    await checkAsset(asset, events, txHash);
  }
}

function parseWsMessage(raw: string): FlatEvents | null {
  try {
    const msg = JSON.parse(raw);
    const events: FlatEvents = msg?.result?.events;
    if (!events || typeof events !== "object") return null;
    if (!("tx.hash" in events)) return null;
    return events;
  } catch {
    return null;
  }
}

export function startMonitor(): void {
  const urls = config.rpc.wsUrls;
  let urlIndex = 0;
  let reconnectDelay = 2000;

  function connect(): void {
    const url = urls[urlIndex];
    console.log(`Connecting to ZigChain WebSocket [${urlIndex + 1}/${urls.length}]: ${url}`);
    const ws = new WebSocket(url);

    ws.on("open", () => {
      reconnectDelay = 2000;
      console.log("WebSocket connected. Subscribing to Tx events...");
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "subscribe",
          id: "tx-monitor",
          params: { query: "tm.event='Tx'" },
        })
      );
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const raw = data.toString();
      const events = parseWsMessage(raw);
      if (!events) return;

      console.log(`[TX RECEIVED] hash=${first(events, "tx.hash")}`);

      processFlatEvents(events).catch((err) =>
        console.error("[ERROR] Processing tx:", err)
      );
    });

    ws.on("error", (err) => {
      console.error("[WS ERROR]:", err.message);
    });

    ws.on("close", (code, reason) => {
      // Rotate to the next configured endpoint (wraps back to the primary
      // once all backups have been tried) so a single dead RPC node
      // doesn't stall the monitor.
      urlIndex = (urlIndex + 1) % urls.length;
      console.warn(
        `[WS CLOSED] code=${code} reason=${reason.toString() || "none"}. ` +
        `Reconnecting in ${reconnectDelay / 1000}s via ${urls[urlIndex]}...`
      );
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        connect();
      }, reconnectDelay);
    });
  }

  connect();
}
