import Groq from "groq-sdk";
import { NextRequest, NextResponse } from "next/server";
import type { AISummary } from "../../../lib/assessment";

export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 503 });
  }
  const client = new Groq({ apiKey });
  const { summary, normalizedScores } = (await req.json()) as {
    summary: AISummary;
    normalizedScores?: { pitchNorm: number; coverageNorm: number; onTimeNorm: number } | null;
  };

  const normText = normalizedScores
    ? `Відносно еталонного запису (100% = рівень еталону): pitch=${normalizedScores.pitchNorm.toFixed(0)}%, coverage=${normalizedScores.coverageNorm.toFixed(0)}%, on-time=${normalizedScores.onTimeNorm.toFixed(0)}%.`
    : "";

  // When the chroma cross-check shows the audio matches but the transcriber
  // dropped notes (dense polyphony), the "missed"/"wrong" counts are detection
  // artifacts, not player mistakes. Instruct the model NOT to blame the student.
  const guidance = summary.transcriptionUnreliable
    ? "ВАЖЛИВО: гармонія запису збігається з нотами, але автоматична транскрипція не розпізнала багато нот (щільна поліфонія). Тому помилки missed/wrong — це обмеження розпізнавання, а НЕ помилки студента. НЕ став оцінку й не лай за пропущені ноти. Поясни це доброзичливо й пораду дай лише про якість запису (наприклад, грати з MIDI чи зробити чистіший/прозоріший запис для точного аналізу)."
    : "Дай студенту коротку конкретну пораду (2–3 речення) на основі даних сесії.";

  const completion = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Ти тренер з фортепіано. Відповідай українською. ${guidance}\nДані сесії:\n${JSON.stringify(summary)}\n${normText}`.trim(),
      },
    ],
  });

  const coaching = completion.choices[0]?.message?.content ?? "";
  return NextResponse.json({ coaching });
}
