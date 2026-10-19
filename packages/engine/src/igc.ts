/**
 * Lecture des fichiers IGC (format FAI « IGC Flight Recorder », annexe A du
 * Technical Specification de la GNSS FR). On garde tous les points tels quels :
 * le repérage des points aberrants se fait plus loin, sans rien effacer.
 */

export class IgcError extends Error {}

export interface IgcFix {
  /** Heure UTC, en millisecondes depuis l'époque Unix. */
  time: number;
  lat: number;
  lon: number;
  /** "A" = position 3D valide, "V" = 2D ou invalide. */
  valid: boolean;
  /** Altitude pression (QNE, 1013,25 hPa), en mètres ; null si absente ("00000" est lu comme absent). */
  pressureAltitude: number | null;
  /** Altitude GNSS (ellipsoïde ou géoïde selon l'instrument), en mètres ; null si absente. */
  gnssAltitude: number | null;
}

export interface IgcHeader {
  /** Date du vol (UTC), "AAAA-MM-JJ". */
  date: string;
  manufacturer?: string;
  loggerId?: string;
  pilot?: string;
  gliderType?: string;
  gliderId?: string;
  competitionId?: string;
  firmware?: string;
  hardware?: string;
  recorderType?: string;
}

export interface IgcFlight {
  header: IgcHeader;
  fixes: IgcFix[];
  /** Présence d'une signature G (sa validité se contrôle à part, via le service FAI). */
  hasSignature: boolean;
  /** Lignes ignorées car illisibles (numéro de ligne, contenu). */
  warnings: string[];
}

function parseDate(ddmmyy: string): string {
  const dd = ddmmyy.slice(0, 2);
  const mm = ddmmyy.slice(2, 4);
  const yy = Number(ddmmyy.slice(4, 6));
  // Les IGC n'ont que deux chiffres d'année : 80-99 = 19xx, sinon 20xx.
  const yyyy = yy >= 80 ? 1900 + yy : 2000 + yy;
  return `${yyyy}-${mm}-${dd}`;
}

function headerValue(line: string): string {
  const i = line.indexOf(":");
  return (i >= 0 ? line.slice(i + 1) : line.slice(5)).trim();
}

/** Lit le texte d'un fichier IGC. */
export function parseIgc(text: string): IgcFlight {
  const lines = text.split(/\r?\n/);
  const header: Partial<IgcHeader> = {};
  const fixes: IgcFix[] = [];
  const warnings: string[] = [];
  let hasSignature = false;
  let dayStart: number | null = null;
  let dayOffset = 0;
  let lastSeconds = -1;

  lines.forEach((line, n) => {
    if (line.length === 0) return;
    const rec = line[0];
    if (rec === "A") {
      header.manufacturer = line.slice(1, 4);
      header.loggerId = line.slice(4, 7);
    } else if (rec === "H") {
      const code = line.slice(2, 5).toUpperCase();
      if (code === "DTE") {
        const m = /(\d{6})/.exec(line.slice(5));
        if (m) header.date = parseDate(m[1]!);
      } else if (code === "PLT") header.pilot = headerValue(line);
      else if (code === "GTY") header.gliderType = headerValue(line);
      else if (code === "GID") header.gliderId = headerValue(line);
      else if (code === "CID") header.competitionId = headerValue(line);
      else if (code === "RFW") header.firmware = headerValue(line);
      else if (code === "RHW") header.hardware = headerValue(line);
      else if (code === "FTY") header.recorderType = headerValue(line);
    } else if (rec === "G") {
      hasSignature = true;
    } else if (rec === "B") {
      if (!header.date) throw new IgcError("Point B trouvé avant la date du vol (HFDTE).");
      const m = /^B(\d{2})(\d{2})(\d{2})(\d{2})(\d{5})([NS])(\d{3})(\d{5})([EW])([AV])([-\d]{5})([-\d]{5})/.exec(line);
      if (!m) {
        warnings.push(`ligne ${n + 1} : point B illisible`);
        return;
      }
      if (dayStart === null) dayStart = Date.parse(`${header.date}T00:00:00Z`);
      const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      // Passage de minuit UTC : l'heure repart de zéro.
      if (lastSeconds >= 0 && seconds < lastSeconds - 12 * 3600) dayOffset += 86400;
      lastSeconds = seconds;
      let lat = Number(m[4]) + Number(m[5]) / 60000;
      if (m[6] === "S") lat = -lat;
      let lon = Number(m[7]) + Number(m[8]) / 60000;
      if (m[9] === "W") lon = -lon;
      const p = Number(m[11]);
      const g = Number(m[12]);
      fixes.push({
        time: dayStart + (seconds + dayOffset) * 1000,
        lat,
        lon,
        valid: m[10] === "A",
        pressureAltitude: Number.isFinite(p) && m[11] !== "00000" ? p : null,
        gnssAltitude: Number.isFinite(g) && m[12] !== "00000" ? g : null,
      });
    }
  });

  if (!header.date) throw new IgcError("Date du vol (HFDTE) absente.");
  return { header: header as IgcHeader, fixes, hasSignature, warnings };
}

/** Écrit un fichier IGC à partir de points (par exemple reconstruits depuis un flux live). Non signé. */
export function writeIgc(flight: { header: IgcHeader; fixes: IgcFix[]; sources?: string[] }): string {
  const h = flight.header;
  const [yyyy, mm, dd] = h.date.split("-");
  const out: string[] = [];
  out.push(`A${(h.manufacturer ?? "XPG").padEnd(3, "X").slice(0, 3)}${(h.loggerId ?? "001").slice(0, 3)}`);
  out.push(`HFDTEDATE:${dd}${mm}${yyyy!.slice(2)},01`);
  if (h.pilot) out.push(`HFPLTPILOTINCHARGE:${h.pilot}`);
  if (h.gliderType) out.push(`HFGTYGLIDERTYPE:${h.gliderType}`);
  if (h.competitionId) out.push(`HFCIDCOMPETITIONID:${h.competitionId}`);
  out.push("HFFTYFRTYPE:pgscore,reconstruction");
  for (const s of flight.sources ?? []) out.push(`LPGSSOURCE:${s}`);
  const pad = (v: number, w: number) => String(Math.trunc(v)).padStart(w, "0");
  const alt = (v: number | null) => {
    if (v === null) return "00000";
    const r = Math.round(v);
    return r < 0 ? "-" + String(-r).padStart(4, "0") : String(r).padStart(5, "0");
  };
  for (const f of flight.fixes) {
    const d = new Date(f.time);
    const t = `${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}`;
    const alat = Math.abs(f.lat);
    let latDeg = Math.floor(alat);
    let latMin = Math.round((alat - latDeg) * 60000);
    const alon = Math.abs(f.lon);
    let lonDeg = Math.floor(alon);
    let lonMin = Math.round((alon - lonDeg) * 60000);
    if (latMin === 60000) {
      latDeg += 1;
      latMin = 0;
    }
    if (lonMin === 60000) {
      lonDeg += 1;
      lonMin = 0;
    }
    out.push(
      `B${t}${pad(latDeg, 2)}${pad(latMin, 5)}${f.lat < 0 ? "S" : "N"}${pad(lonDeg, 3)}${pad(lonMin, 5)}${f.lon < 0 ? "W" : "E"}${f.valid ? "A" : "V"}${alt(f.pressureAltitude)}${alt(f.gnssAltitude)}`,
    );
  }
  return out.join("\r\n") + "\r\n";
}
