/**
 * The shipped brand mishearing table: what a Speech Engine says when it hears "Codictate",
 * mapped back to the product name.
 *
 * Above the Speech Engine seam on purpose. It used to be applied inside the transcribe path,
 * so `benchmarks/stt/runner.ts` imported it and scored WER on a corrected hypothesis rather
 * than on what the engine actually said. That matters more than it looks: the table rewrites
 * Danish-shaped strings (`kodigtede`, `ko digtet`) into the product name, and hviske is
 * scored on FLEURS `da_dk`. Applying it in the Dictation pipeline instead makes the
 * benchmark's correctness fall out of the structure, with no flag for the benchmark to turn
 * off. See docs/adr/0006-dictation-returns-an-outcome.md.
 *
 * This is not the user Dictionary. `applyDictionary` is the user's own table, applied after
 * this one and never seen by the benchmark either.
 *
 * Order: phrase mishearings first, then codec+tate|tape|sheet|shade (incl. Codec Tate, Codec
 * Tape, Codec Sheet, Codic shade, glued forms), then kodictate/codictate (any casing).
 */
const BRAND_TRANSCRIPT_FIXES: [RegExp, string][] = [
  [/\bcode\s+dictate\b/gi, 'Codictate'],
  [/\bcoding\s*tate\b/gi, 'Codictate'],
  [/\bco(?:\s+|[-–—]\s*)dictate\b/gi, 'Codictate'],
  [/\bkodi\s+dicate\b/gi, 'Codictate'],
  [/\bkodi\s+tat\b/gi, 'Codictate'],
  [/\bkodik\s+tat\b/gi, 'Codictate'],
  [/\bkodik\s+tet\b/gi, 'Codictate'],
  [/\bkodiktet\b/gi, 'Codictate'],
  [/\bkodiktete\b/gi, 'Codictate'],
  [/\bkodig\s+tate\b/gi, 'Codictate'],
  [/\bkodigtate\b/gi, 'Codictate'],
  [/\bkodig\s+tet\b/gi, 'Codictate'],
  [/\bkodigtet\b/gi, 'Codictate'],
  [/\bko\s+digtet\b/gi, 'Codictate'],
  [/\bkodigt\s+tade\b/gi, 'Codictate'],
  [/\bkodigttade\b/gi, 'Codictate'],
  [/\bkodigtede\b/gi, 'Codictate'],
  [/\bkodig\s+tede\b/gi, 'Codictate'],
  [/\bko\s+digtede\b/gi, 'Codictate'],
  [/\bKodak\s+Tech\b/gi, 'Codictate'],
  [/\bKodakTech\b/gi, 'Codictate'],
  [/\bcodec\s+cheat\b/gi, 'Codictate'],
  [/\bcodeccheat\b/gi, 'Codictate'],
  [/\bcodec\s+sheet\b/gi, 'Codictate'],
  [/\bcodecsheet\b/gi, 'Codictate'],
  [/\bcodic\s+shade\b/gi, 'Codictate'],
  [/\bcodicshade\b/gi, 'Codictate'],
  [/\bcodec\s*t(?:ate|ape)\b/gi, 'Codictate'],
  [/\bcodec\s+tade\b/gi, 'Codictate'],
  [/\bcodectade\b/gi, 'Codictate'],
  [/\bcodexade\b/gi, 'Codictate'],
  [/\bcodex\s+ade\b/gi, 'Codictate'],
  [/\bcode\s+xade\b/gi, 'Codictate'],
  [/\bkodiktat\b/gi, 'Codictate'],
  [/\bkodiktate\b/gi, 'Codictate'],
  [/\bkodic\s+tate\b/gi, 'Codictate'],
  [/\bkodictate\b/gi, 'Codictate'],
  [/\bcodictate\b/gi, 'Codictate'],
  [/\bCodigTate\b/gi, 'Codictate'],
  [/\bCodig\s+Tate\b/gi, 'Codictate'],
  [/\bCodeictate\b/gi, 'Codictate'],
]

/** The Raw Transcript with every known mishearing of the product name replaced. */
export function fixBrandMishearings(text: string): string {
  let t = text
  for (const [pattern, replacement] of BRAND_TRANSCRIPT_FIXES) {
    t = t.replace(pattern, replacement)
  }
  return t
}
