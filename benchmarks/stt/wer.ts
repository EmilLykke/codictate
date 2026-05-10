import { normalizeForWer, normalizeForCer } from "./normalize";

export interface WerResult {
  wer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  refWords: number;
}

export interface CerResult {
  cer: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  refChars: number;
}

function levenshteinOps(ref: string[], hyp: string[]): WerResult {
  const n = ref.length;
  const m = hyp.length;

  // dp[i][j] = { cost, sub, ins, del }
  const dp: { cost: number; sub: number; ins: number; del: number }[][] = [];
  for (let i = 0; i <= n; i++) {
    dp[i] = [];
    for (let j = 0; j <= m; j++) {
      dp[i][j] = { cost: 0, sub: 0, ins: 0, del: 0 };
    }
  }

  for (let i = 1; i <= n; i++) {
    dp[i][0] = { cost: i, sub: 0, ins: 0, del: i };
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = { cost: j, sub: 0, ins: j, del: 0 };
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = { ...dp[i - 1][j - 1] };
      } else {
        const sub = dp[i - 1][j - 1].cost + 1;
        const del = dp[i - 1][j].cost + 1;
        const ins = dp[i][j - 1].cost + 1;

        if (sub <= del && sub <= ins) {
          dp[i][j] = {
            cost: sub,
            sub: dp[i - 1][j - 1].sub + 1,
            ins: dp[i - 1][j - 1].ins,
            del: dp[i - 1][j - 1].del,
          };
        } else if (del <= ins) {
          dp[i][j] = {
            cost: del,
            sub: dp[i - 1][j].sub,
            ins: dp[i - 1][j].ins,
            del: dp[i - 1][j].del + 1,
          };
        } else {
          dp[i][j] = {
            cost: ins,
            sub: dp[i][j - 1].sub,
            ins: dp[i][j - 1].ins + 1,
            del: dp[i][j - 1].del,
          };
        }
      }
    }
  }

  const result = dp[n][m];
  return {
    wer: n === 0 ? (m === 0 ? 0 : 1) : result.cost / n,
    substitutions: result.sub,
    insertions: result.ins,
    deletions: result.del,
    refWords: n,
  };
}

export function computeWer(reference: string, hypothesis: string): WerResult {
  const refWords = normalizeForWer(reference).split(" ").filter(Boolean);
  const hypWords = normalizeForWer(hypothesis).split(" ").filter(Boolean);
  return levenshteinOps(refWords, hypWords);
}

export function computeCer(reference: string, hypothesis: string): CerResult {
  const refChars = [...normalizeForCer(reference)];
  const hypChars = [...normalizeForCer(hypothesis)];
  const ops = levenshteinOps(refChars, hypChars);
  return {
    cer: ops.wer,
    substitutions: ops.substitutions,
    insertions: ops.insertions,
    deletions: ops.deletions,
    refChars: ops.refWords,
  };
}
