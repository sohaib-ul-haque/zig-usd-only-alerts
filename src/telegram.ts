import { config } from "./config";
import { formatRawAmount, rawToDecimalString } from "./amount";

const BASE = `https://api.telegram.org/bot${config.telegram.botToken}`;

async function sendToChat(text: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(config.rpc.timeoutMs),
    });
    if (!res.ok) {
      console.error(`Telegram error: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("Failed to send message:", err);
  }
}

export async function sendAlert(
  symbol: string,
  denom: string,
  rawAmount: bigint,
  decimals: number,
  sender: string,
  recipient: string,
  txHash: string,
  usdPrice: number | null,
  supportsUsd: boolean
): Promise<void> {
  const amount = formatRawAmount(rawAmount, decimals);
  // This Number conversion is deliberately limited to the cosmetic USD estimate.
  // Denom matching and threshold decisions are completed with the exact bigint.
  const approximateAmount = Number(rawToDecimalString(rawAmount, decimals));
  const usdValue = usdPrice !== null ? approximateAmount * usdPrice : null;

  const usdLine = !supportsUsd
    ? ""
    : usdValue !== null
      ? `USD Value: ~$${usdValue.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} (@ $${usdPrice!.toFixed(4)} / ${symbol})\n`
      : "USD Value: unavailable\n";

  const text =
    `🚨 Large ${symbol} Transfer Detected\n\n` +
    `Wallet: ${recipient}\n` +
    `Direction: Received\n\n` +
    `Sender: ${sender}\n` +
    `Recipient: ${recipient}\n\n` +
    `Amount: ${amount} ${symbol} (${rawAmount.toLocaleString("en-US")} ${denom})\n` +
    usdLine +
    `Type: Transfer\n\n` +
    `Tx: ${config.txExplorer}${txHash}`;

  console.log(text);
  console.log("=".repeat(50));
  await sendToChat(text);
}
