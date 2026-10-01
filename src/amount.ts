function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid asset decimals: ${decimals}`);
  }
}

export function parseRawAmount(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid raw amount: ${value}`);
  }
  return BigInt(value);
}

export function decimalToRaw(value: string, decimals: number): bigint {
  assertDecimals(decimals);

  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }

  const whole = match[1];
  let fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    const discarded = fraction.slice(decimals);
    if (!/^0*$/.test(discarded)) {
      throw new Error(`Amount ${value} exceeds ${decimals} decimal places`);
    }
    fraction = fraction.slice(0, decimals);
  }

  const scale = 10n ** BigInt(decimals);
  const fractionRaw = fraction.padEnd(decimals, "0");
  return BigInt(whole) * scale + BigInt(fractionRaw || "0");
}

export function rawToDecimalString(rawAmount: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (rawAmount < 0n) {
    throw new Error("Raw asset amounts cannot be negative");
  }

  if (decimals === 0) return rawAmount.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = rawAmount / scale;
  const fraction = (rawAmount % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function formatRawAmount(rawAmount: bigint, decimals: number): string {
  const decimal = rawToDecimalString(rawAmount, decimals);
  const [whole, fraction] = decimal.split(".");
  const groupedWhole = BigInt(whole).toLocaleString("en-US");
  return fraction ? `${groupedWhole}.${fraction}` : groupedWhole;
}
