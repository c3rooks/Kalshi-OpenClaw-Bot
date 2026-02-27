import { getResolvedDecisionFeatureRows, type ResolvedDecisionFeatureRow } from "../db/queries";
import { getSetting, setSetting } from "../settings/settingsStore";
import { logger } from "../utils/logger";

export type FeatureCalibrationParams = {
  bias: number;
  wEdge: number;
  wQuality: number;
  wFill: number;
  wConviction: number;
  wCost: number;
};

export type FeatureCalibrationSettings = {
  updatedTs: number;
  lookbackDays: number;
  samples: {
    total: number;
    train: number;
    test: number;
  };
  params: FeatureCalibrationParams;
  metrics: {
    baselineBrier: number;
    trainedBrier: number;
    testBrier: number;
    baselineLogLoss: number;
    trainedLogLoss: number;
    testLogLoss: number;
  };
};

const SETTINGS_KEY = "learning.feature_calibration.v1";

type NormalizedFeatureRow = {
  xEdge: number;
  xQuality: number;
  xFill: number;
  xConviction: number;
  xCost: number;
  y: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function defaultSettings(): FeatureCalibrationSettings {
  return {
    updatedTs: 0,
    lookbackDays: 180,
    samples: { total: 0, train: 0, test: 0 },
    params: {
      bias: -0.12,
      wEdge: 1.1,
      wQuality: 0.5,
      wFill: 0.55,
      wConviction: 0.45,
      wCost: 0.8
    },
    metrics: {
      baselineBrier: 0.25,
      trainedBrier: 0.25,
      testBrier: 0.25,
      baselineLogLoss: 0.693147,
      trainedLogLoss: 0.693147,
      testLogLoss: 0.693147
    }
  };
}

function normalizeRow(row: ResolvedDecisionFeatureRow): NormalizedFeatureRow | null {
  const edge = Number(row.edge);
  const quality = Number(row.quality_score);
  const fill = Number(row.fill_prob);
  const expectedCost = Number(row.expected_cost);
  const implied = Number(row.implied_price);
  const pModel = Number(row.p_model);
  if (!Number.isFinite(edge) || !Number.isFinite(quality) || !Number.isFinite(fill)) return null;
  const xEdge = clamp(edge / 0.08, -2, 2);
  const xQuality = clamp(quality / 100, 0, 1);
  const xFill = clamp(fill, 0, 1);
  const impliedSafe = Number.isFinite(implied) ? implied : 0.5;
  const pSafe = Number.isFinite(pModel) ? pModel : impliedSafe;
  const xConviction = clamp(Math.abs(pSafe - impliedSafe) / 0.2, 0, 1.5);
  const xCost = clamp((Number.isFinite(expectedCost) ? expectedCost : 0) / 0.1, 0, 2.5);
  const y = row.outcome === "WIN" ? 1 : 0;
  return { xEdge, xQuality, xFill, xConviction, xCost, y };
}

function predictInternal(x: Omit<NormalizedFeatureRow, "y">, p: FeatureCalibrationParams): number {
  const z = p.bias + p.wEdge * x.xEdge + p.wQuality * x.xQuality + p.wFill * x.xFill + p.wConviction * x.xConviction - p.wCost * x.xCost;
  return clamp(sigmoid(z), 0.001, 0.999);
}

function brier(rows: NormalizedFeatureRow[], params: FeatureCalibrationParams): number {
  if (!rows.length) return 0.25;
  let s = 0;
  for (const r of rows) {
    const p = predictInternal(r, params);
    const d = p - r.y;
    s += d * d;
  }
  return s / rows.length;
}

function logLoss(rows: NormalizedFeatureRow[], params: FeatureCalibrationParams): number {
  if (!rows.length) return 0.693147;
  let s = 0;
  for (const r of rows) {
    const p = predictInternal(r, params);
    s += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  }
  return s / rows.length;
}

function trainLogistic(rows: NormalizedFeatureRow[], init: FeatureCalibrationParams): FeatureCalibrationParams {
  if (!rows.length) return init;
  let p: FeatureCalibrationParams = { ...init };
  const lambda = 0.002;
  for (let epoch = 0; epoch < 360; epoch += 1) {
    const lr = 0.05 / (1 + epoch * 0.01);
    let gb = 0;
    let ge = 0;
    let gq = 0;
    let gf = 0;
    let gc = 0;
    let gk = 0;
    for (const r of rows) {
      const yhat = predictInternal(r, p);
      const err = yhat - r.y;
      gb += err;
      ge += err * r.xEdge;
      gq += err * r.xQuality;
      gf += err * r.xFill;
      gc += err * r.xConviction;
      gk += err * (-r.xCost);
    }
    const n = rows.length;
    gb /= n;
    ge = ge / n + lambda * p.wEdge;
    gq = gq / n + lambda * p.wQuality;
    gf = gf / n + lambda * p.wFill;
    gc = gc / n + lambda * p.wConviction;
    gk = gk / n + lambda * p.wCost;

    p = {
      bias: clamp(p.bias - lr * gb, -3, 3),
      wEdge: clamp(p.wEdge - lr * ge, -4, 4),
      wQuality: clamp(p.wQuality - lr * gq, -4, 4),
      wFill: clamp(p.wFill - lr * gf, -4, 4),
      wConviction: clamp(p.wConviction - lr * gc, -4, 4),
      wCost: clamp(p.wCost - lr * gk, -4, 4)
    };
  }
  return p;
}

export function getFeatureCalibrationSettings(): FeatureCalibrationSettings {
  return getSetting<FeatureCalibrationSettings>(SETTINGS_KEY, defaultSettings()) ?? defaultSettings();
}

export function predictCalibratedWinProb(input: {
  edge: number;
  quality: number;
  fillProb: number;
  confidence: number;
  pModel: number;
  impliedPrice: number;
  expectedCost: number;
}): number {
  const cfg = getFeatureCalibrationSettings();
  const x: Omit<NormalizedFeatureRow, "y"> = {
    xEdge: clamp(input.edge / 0.08, -2, 2),
    xQuality: clamp(input.quality / 100, 0, 1),
    xFill: clamp(input.fillProb, 0, 1),
    xConviction: clamp(Math.abs(input.pModel - input.impliedPrice) / 0.2, 0, 1.5),
    xCost: clamp(input.expectedCost / 0.1, 0, 2.5)
  };
  const base = predictInternal(x, cfg.params);
  const confBlend = clamp(input.confidence, 0, 1);
  return clamp(base * (0.6 + 0.4 * confBlend) + 0.5 * (1 - confBlend) * 0.2, 0.001, 0.999);
}

export function recalibrateFeatureModelFromDb(opts?: { lookbackDays?: number; minSamples?: number }): FeatureCalibrationSettings {
  const lookbackDays = Math.max(30, Number(opts?.lookbackDays ?? 180));
  const minSamples = Math.max(80, Number(opts?.minSamples ?? 300));
  const raw = getResolvedDecisionFeatureRows({ lookbackDays, limit: 10000 });
  const rows = raw.map(normalizeRow).filter((r): r is NormalizedFeatureRow => r != null);

  const baseline = defaultSettings().params;
  if (rows.length < minSamples) {
    const prev = getFeatureCalibrationSettings();
    const out: FeatureCalibrationSettings = {
      ...prev,
      updatedTs: Date.now(),
      lookbackDays,
      samples: { total: rows.length, train: rows.length, test: 0 }
    };
    setSetting(SETTINGS_KEY, out);
    logger.info("Feature calibration skipped (insufficient samples)", { samples: rows.length, minSamples });
    return out;
  }

  const split = Math.max(1, Math.floor(rows.length * 0.8));
  const train = rows.slice(0, split);
  const test = rows.slice(split);
  const trained = trainLogistic(train, baseline);

  const baselineBrier = brier(train, baseline);
  const trainedBrier = brier(train, trained);
  const testBrier = test.length ? brier(test, trained) : trainedBrier;
  const baselineLogLoss = logLoss(train, baseline);
  const trainedLogLoss = logLoss(train, trained);
  const testLogLoss = test.length ? logLoss(test, trained) : trainedLogLoss;

  const out: FeatureCalibrationSettings = {
    updatedTs: Date.now(),
    lookbackDays,
    samples: { total: rows.length, train: train.length, test: test.length },
    params: trained,
    metrics: {
      baselineBrier: Number(baselineBrier.toFixed(6)),
      trainedBrier: Number(trainedBrier.toFixed(6)),
      testBrier: Number(testBrier.toFixed(6)),
      baselineLogLoss: Number(baselineLogLoss.toFixed(6)),
      trainedLogLoss: Number(trainedLogLoss.toFixed(6)),
      testLogLoss: Number(testLogLoss.toFixed(6))
    }
  };

  setSetting(SETTINGS_KEY, out);
  logger.info("Feature calibration updated", {
    samples: out.samples,
    params: out.params,
    metrics: out.metrics
  });
  return out;
}

