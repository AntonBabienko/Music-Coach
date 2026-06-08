import { NextRequest, NextResponse } from "next/server";
import { readdir } from "fs/promises";
import { join } from "path";
import AdmZip from "adm-zip";

const APP_DIR = process.env.AUDIVERIS_APP_DIR ?? "D:\\audiveris\\Audiveris\\app";

// NOTE: spawning Java from within the VS Code extension process is blocked by
// Windows Job Object restrictions in that environment. When Next.js is started
// from a regular terminal (outside VS Code), the subprocess approach below can
// be re-enabled. For now, the route handles .mxl uploads directly.

export const maxDuration = 120;

async function extractXmlFromMxl(buf: Buffer): Promise<string> {
  const zip = new AdmZip(buf);
  const entry = zip
    .getEntries()
    .find((e) => e.entryName.endsWith(".xml") && !e.entryName.startsWith("META-INF"));
  if (!entry) throw new Error("No MusicXML found inside .mxl archive");
  return entry.getData().toString("utf-8");
}

async function runAudiveris(inPath: string, outDir: string): Promise<string> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { readFile } = await import("fs/promises");
  const { join: j } = await import("path");
  const execA = promisify(execFile);

  const JAVA_EXE = process.env.AUDIVERIS_JAVA_EXE ?? "D:\\audiveris\\Audiveris\\runtime\\bin\\java.exe";

  let jars: string[];
  try {
    jars = (await readdir(APP_DIR)).filter((f) => f.endsWith(".jar"));
  } catch {
    throw new Error(`APP_DIR не знайдено або недоступно: "${APP_DIR}". Перевірте AUDIVERIS_APP_DIR.`);
  }
  if (jars.length === 0) {
    throw new Error(`У директорії "${APP_DIR}" немає .jar файлів.`);
  }
  const cp = jars.map((f) => j(APP_DIR, f)).join(";");

  const javaArgs = [
    "-Djava.awt.headless=true",
    "-Dfile.encoding=UTF-8",
    "-Xmx2G",
    "-cp", cp,
    "org.audiveris.omr.Main",
    "-batch", "-export",
    "-output", outDir,
    inPath,
  ];

  try {
    await execA(JAVA_EXE, javaArgs, {
      timeout: 110_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (execErr: unknown) {
    const e = execErr as Error & { stdout?: string; stderr?: string; code?: number };
    const detail = [
      e.code != null ? `exit code ${e.code}` : "",
      e.stderr?.slice(-2000).trim() || "",
      e.stdout?.slice(-2000).trim() || "",
    ].filter(Boolean).join(" | ");
    throw new Error(`Java: ${detail || e.message}`);
  }

  async function findByExt(dir: string, ext: string): Promise<string | undefined> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = j(dir, e.name);
      if (e.isDirectory()) {
        const found = await findByExt(full, ext);
        if (found) return found;
      } else if (e.name.endsWith(ext)) {
        return full;
      }
    }
    return undefined;
  }

  // 1. Try .mxl (compressed MusicXML)
  const mxlPath = await findByExt(outDir, ".mxl");
  if (mxlPath) return extractXmlFromMxl(await readFile(mxlPath));

  // 2. Try .xml (uncompressed MusicXML export from Audiveris)
  const xmlPath = await findByExt(outDir, ".xml");
  if (xmlPath) return (await readFile(xmlPath)).toString("utf-8");

  // 3. Try extracting MusicXML from .omr (Audiveris project ZIP)
  const omrPath = await findByExt(outDir, ".omr");
  if (omrPath) {
    const zip = new AdmZip(await readFile(omrPath));
    const xmlEntry = zip.getEntries().find((e) => {
      if (!e.entryName.endsWith(".xml")) return false;
      const text = e.getData().toString("utf-8");
      return text.includes("score-partwise") || text.includes("score-timewise");
    });
    if (xmlEntry) return xmlEntry.getData().toString("utf-8");
  }

  // Diagnostics: list what's actually in outDir
  async function listAll(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const results: string[] = [];
    for (const e of entries) {
      const full = j(dir, e.name);
      results.push(full);
      if (e.isDirectory()) results.push(...await listAll(full));
    }
    return results;
  }
  const found = await listAll(outDir);
  const logPath = found.find((f) => f.endsWith(".log"));
  let logTail = "";
  if (logPath) {
    const logText = await readFile(logPath, "utf-8").catch(() => "");
    logTail = logText.split("\n").slice(-30).join("\n");
  }
  const detail = found.length ? found.map((f) => f.split("\\").pop()).join(", ") : "порожня директорія";
  throw new Error(`Audiveris produced no usable output. Files: ${detail}\nLOG:\n${logTail}`);
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  try {
    // .mxl — Audiveris compressed MusicXML, extract directly
    if (ext === "mxl") {
      const xml = await extractXmlFromMxl(buf);
      return NextResponse.json({ xml });
    }

    // .xml / .musicxml — return as-is
    if (ext === "xml" || ext === "musicxml") {
      return NextResponse.json({ xml: buf.toString("utf-8") });
    }

    // .pdf / image — attempt Audiveris subprocess (works when Next.js is started
    // from a regular terminal, not from within the VS Code extension process)
    const { writeFile, rm, mkdir: mkdirFs } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const outDir = join(tmpdir(), `omr-out-${id}`);

    // Audiveris on Windows handles TIFF reliably; convert raster images to TIFF
    const isImage = ["png", "jpg", "jpeg", "webp", "bmp", "gif"].includes(ext);
    let inBuf: Buffer = buf as Buffer;
    let inExt = ext || "pdf";
    if (isImage) {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(buf).metadata();
      const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
      // Audiveris needs ~300 DPI; target 3000px so even thin staff lines are clear
      const targetLongest = Math.max(longest, 3000);
      const isWide = (meta.width ?? 0) >= (meta.height ?? 1);
      inBuf = await sharp(buf)
        .resize({ [isWide ? "width" : "height"]: targetLongest, kernel: "lanczos3" })
        .grayscale()
        // CLAHE evens out uneven photo lighting without destroying local contrast
        .clahe({ width: 64, height: 64, maxSlope: 4 })
        .normalize()
        .sharpen({ sigma: 0.4 })
        .tiff({ compression: "lzw", xres: 300, yres: 300, resolutionUnit: "inch" })
        .toBuffer() as Buffer;
      inExt = "tif";
    }

    const inPath = join(tmpdir(), `omr-${id}.${inExt}`);
    try {
      await mkdirFs(outDir, { recursive: true });
      await writeFile(inPath, inBuf);
      const xml = await runAudiveris(inPath, outDir);
      return NextResponse.json({ xml });
    } catch (err) {
      return NextResponse.json(
        { error: `Audiveris: ${(err as Error).message}. Запустіть Audiveris вручну і завантажте .mxl файл.` },
        { status: 500 }
      );
    } finally {
      await rm(inPath, { force: true }).catch((err) => { console.warn("cleanup inPath:", err); });
      await rm(outDir, { recursive: true, force: true }).catch((err) => { console.warn("cleanup outDir:", err); });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
