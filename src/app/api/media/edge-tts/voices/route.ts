import { NextResponse } from "next/server";

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

const VOICES_URL =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const TTL_MS = 24 * 60 * 60 * 1000;

let cache: { expiresAt: number; voices: EdgeVoice[] } | null = null;

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
  const language = languageCode ? languageNames.of(languageCode.toLowerCase()) || languageCode : locale;
  const region = regionCode ? regionNames.of(regionCode.toUpperCase()) || regionCode : "";

  if (voiceName && language) {
    return `${voiceName} (${region ? `${region} ${language}` : language})`;
  }

  return friendly || shortName;
}

async function fetchVoices(): Promise<EdgeVoice[]> {
  const res = await fetch(VOICES_URL, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Edge voice list request failed (${res.status})`);

  const data = (await res.json()) as EdgeVoiceRaw[];
  return data
    .map((v) => ({ id: v.ShortName || "", label: toDisplayLabel(v), locale: v.Locale || "" }))
    .filter((v) => Boolean(v.id))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function GET() {
  try {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return NextResponse.json({ voices: cache.voices, cached: true });
    }

    const voices = await fetchVoices();
    cache = { voices, expiresAt: now + TTL_MS };
    return NextResponse.json({ voices, cached: false });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Failed to load voices" }, { status: 502 });
  }
}
