import { NextResponse } from "next/server";

import { getDbInstance } from "@/lib/db/core";

type EdgeVoiceRaw = {
  ShortName?: string;
  Locale?: string;
  FriendlyName?: string;
};

type EdgeVoice = {
  id: string;
  label: string;
  locale: string;
};

type EdgeTtsVoicesCache = {
  updatedAt: number;
  voices: EdgeVoice[];
};

const VOICES_URL =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_NAMESPACE = "edgeTtsVoices";
const CACHE_KEY = "global";

function isFresh(updatedAt: number, now = Date.now()) {
  return now - updatedAt < TTL_MS;
}

function toDisplayLabel(voice: EdgeVoiceRaw): string {
  const shortName = voice.ShortName || "";
  const locale = voice.Locale || "";
  const friendly = voice.FriendlyName || "";

  const nameMatch = shortName.match(/^[a-z]{2}-[A-Z]{2}-(.+)$/);
  const voiceName = nameMatch?.[1]?.replace(/Neural$/i, "") || shortName;

  const localeParts = locale.split("-");
  const languageCode = localeParts[0] || "";
  const regionCode = localeParts[1] || "";

  const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
  const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

  let language = locale;
  if (languageCode) {
    try {
      language = languageNames.of(languageCode.toLowerCase()) || languageCode;
    } catch {
      language = languageCode;
    }
  }

  let region = "";
  if (regionCode) {
    try {
      region = regionNames.of(regionCode.toUpperCase()) || regionCode;
    } catch {
      region = regionCode;
    }
  }

  if (voiceName && language) {
    return `${voiceName} (${region ? `${region} ${language}` : language})`;
  }

  return friendly || shortName;
}

function readDbCache(): EdgeTtsVoicesCache | null {
  try {
    const db = getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(CACHE_NAMESPACE, CACHE_KEY) as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<EdgeTtsVoicesCache>;
    if (!Array.isArray(parsed.voices) || typeof parsed.updatedAt !== "number") return null;
    return { updatedAt: parsed.updatedAt, voices: parsed.voices as EdgeVoice[] };
  } catch {
    return null;
  }
}

function writeDbCache(cache: EdgeTtsVoicesCache) {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    CACHE_NAMESPACE,
    CACHE_KEY,
    JSON.stringify(cache)
  );
}

async function fetchVoices(): Promise<EdgeVoice[]> {
  const res = await fetch(VOICES_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Edge voice list request failed (${res.status})`);

  const data = (await res.json()) as EdgeVoiceRaw[] | { ShowCaptcha?: boolean };
  if (!Array.isArray(data)) {
    if ((data as { ShowCaptcha?: boolean }).ShowCaptcha) {
      throw new Error("Edge voice list blocked by captcha");
    }
    throw new Error("Unexpected Edge voice list response");
  }

  return data
    .map((v) => ({ id: v.ShortName || "", label: toDisplayLabel(v), locale: v.Locale || "" }))
    .filter((v) => Boolean(v.id))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function GET() {
  const now = Date.now();
  const dbCache = readDbCache();

  if (dbCache && isFresh(dbCache.updatedAt, now)) {
    return NextResponse.json({ voices: dbCache.voices, cached: true, source: "db" });
  }

  try {
    console.log("[EdgeTTSVoices] Refreshing voice cache from remote");
    const voices = await fetchVoices();
    writeDbCache({ updatedAt: now, voices });
    console.log(`[EdgeTTSVoices] Voice cache updated (${voices.length} voices)`);
    return NextResponse.json({ voices, cached: false, source: "remote" });
  } catch (error: any) {
    console.warn("[EdgeTTSVoices] Voice cache refresh failed:", error?.message || error);
    if (dbCache?.voices?.length) {
      return NextResponse.json({
        voices: dbCache.voices,
        cached: true,
        source: "stale-cache",
        warning: error?.message || "Failed to refresh voices",
      });
    }

    return NextResponse.json({ error: error?.message || "Failed to load voices" }, { status: 502 });
  }
}
