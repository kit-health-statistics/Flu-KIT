import { FORECASTLE_CONFIG } from '../config';

const buildPoissonInterval = (mean, zScore) => {
  if (!Number.isFinite(mean) || mean <= 0) {
    return { width: 0 };
  }
  const sd = Math.sqrt(mean);
  const width = Math.round(zScore * sd);
  return { width };
};

export const initialiseForecastInputs = (horizons = [], baselineValue = 0) => {
  const mean = Number.isFinite(baselineValue) && baselineValue > 0 ? baselineValue : 0;
  const interval80 = buildPoissonInterval(mean, FORECASTLE_CONFIG.confidence.zScore80);
  return horizons.map((horizon) => ({
    horizon,
    median: mean,
    width80: interval80.width,
    lower80: Math.max(0, mean - interval80.width),
    upper80: mean + interval80.width,
  }));
};

export const convertToIntervals = (entries) => {
  return entries.map(entry => ({
    horizon: entry.horizon,
    interval80: {
      lower: entry.lower80 !== undefined ? entry.lower80 : Math.max(0, entry.median - entry.width80),
      upper: entry.upper80 !== undefined ? entry.upper80 : entry.median + entry.width80,
    },
  }));
};