const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

export function relativeTime(iso: string, now = Date.now()): string {
  const deltaMs = new Date(iso).getTime() - now;
  const abs = Math.abs(deltaMs);
  if (abs < 60_000) return formatter.format(Math.round(deltaMs / 1_000), "second");
  if (abs < 3_600_000) return formatter.format(Math.round(deltaMs / 60_000), "minute");
  if (abs < 86_400_000) return formatter.format(Math.round(deltaMs / 3_600_000), "hour");
  return formatter.format(Math.round(deltaMs / 86_400_000), "day");
}

export function preciseRelativeTime(iso: string, now = Date.now()): string {
  const deltaMinutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  const amount = Math.abs(deltaMinutes);
  if (amount < 1) return "less than a minute ago";
  return deltaMinutes < 0 ? `${amount} minute${amount === 1 ? "" : "s"} ago` : `in ${amount} minute${amount === 1 ? "" : "s"}`;
}
