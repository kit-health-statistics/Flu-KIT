import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarElement,
  BarController,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
} from 'chart.js';
import { getRelativePosition } from 'chart.js/helpers';
import { Chart } from 'react-chartjs-2';
import { CHART_CONFIG, FORECASTLE_CONFIG } from '../../config';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  ScatterController,
  BarElement,
  BarController,
  Tooltip,
  Legend,
  Filler,
);

// =============================================================================
// Constants
// =============================================================================

// A "season" runs from week 40 through week 39 of the following year. To plot
// this as a single continuous numeric x-axis, weeks 1-39 are shifted forward
// by CONTINUOUS_WEEK_OFFSET so they sort after week 52 instead of wrapping
// back to the start (e.g. week 1 becomes "continuous week" 53).
const CURRENT_SEASON_FIRST_WEEK = 40;
const CURRENT_SEASON_LAST_WEEK = 52;
const CONTINUOUS_WEEK_OFFSET = CURRENT_SEASON_LAST_WEEK; // 52
const CONTINUOUS_SEASON_LAST_WEEK = 39 + CONTINUOUS_WEEK_OFFSET; // 91

// Last week shown in the "whole season" view (continuous week 72 = calendar week 20).
const FULL_VIEW_LAST_WEEK = 72;

const COLORS = {
  interval80: CHART_CONFIG.forecastleColors?.interval80 || '#dc143c',
  median: '#000000',
  handleMedian: '#dc143c',
  handleOutline: '#000000',
  scoringForecast: '#dc143c',
  white: '#ffffff',
};

// Styles for the past-season overlays. Colors come from a colour-blind-friendly
// palette (and avoid the red used for the forecast); each season also gets its
// own dash pattern, so they stay distinguishable even in grayscale.
const PAST_SEASON_STYLES = {
  previous: { color: '#808080', dash: [6, 4], width: 2 },
  twoBefore: { color: '#0072B2', dash: [2, 3], width: 1.75 },
  threeBefore: { color: '#E69F00', dash: [10, 3, 2, 3], width: 1.75 },
};

// =============================================================================
// Week / date helpers
// =============================================================================

/** Formats a continuous week number back into the "W<week>" label shown on the axis. */
const formatWeekDisplay = (weekNum) => {
  if (weekNum > CURRENT_SEASON_LAST_WEEK) {
    return `W${weekNum - CONTINUOUS_WEEK_OFFSET}`;
  }
  return `W${weekNum}`;
};

/** Extracts the ISO week number (1-52) from a "YYYY-WXX" string, or null if malformed. */
const getWeekNumberFromDate = (weekStr) => {
  if (!weekStr || typeof weekStr !== 'string') return null;
  const match = weekStr.match(/^\d{4}-W(\d{1,2})$/);
  return match ? parseInt(match[1], 10) : null;
};

/**
 * Maps a real ISO week number onto the continuous season scale.
 * Weeks 40-52 are unchanged; weeks 1-39 are shifted to 53-91 so the whole
 * season plots left-to-right without wrapping.
 */
const transformWeekToContinuous = (weekNum) => {
  if (weekNum >= CURRENT_SEASON_FIRST_WEEK && weekNum <= CURRENT_SEASON_LAST_WEEK) {
    return weekNum;
  }
  if (weekNum >= 1 && weekNum < CURRENT_SEASON_FIRST_WEEK) {
    return weekNum + CONTINUOUS_WEEK_OFFSET;
  }
  return weekNum;
};

/** Reverse of transformWeekToContinuous, for display purposes only. */
const transformContinuousToDisplay = (continuousWeek) => formatWeekDisplay(continuousWeek);

/** Convenience: parse a "YYYY-WXX" string straight to its continuous week number. */
const getContinuousWeekFromDate = (weekStr) => {
  const weekNum = getWeekNumberFromDate(weekStr);
  return weekNum === null ? null : transformWeekToContinuous(weekNum);
};

/** Builds the fixed set of x-axis labels for a full season, starting at week 40. */
const buildSeasonLabels = () => {
  const labels = [];
  for (let w = CURRENT_SEASON_FIRST_WEEK; w <= CURRENT_SEASON_LAST_WEEK; w++) {
    labels.push(w);
  }
  for (let w = CURRENT_SEASON_LAST_WEEK + 1; w <= CONTINUOUS_SEASON_LAST_WEEK; w++) {
    labels.push(w);
  }
  return labels;
};

/** Converts a raw {date, value} series into {x, y} points on the continuous week scale. */
const mapDataToContinuousWeeks = (series) => {
  if (!series?.length) return [];
  return series
    .map((entry) => {
      const weekNum = getWeekNumberFromDate(entry.date);
      return weekNum === null ? null : { x: transformWeekToContinuous(weekNum), y: entry.value };
    })
    .filter(Boolean);
};

/**
 * Re-indexes a sparse set of {x, y} points onto a fixed set of x-axis labels,
 * filling any week with no data point with y: null (so Chart.js draws a gap).
 */
const alignPointsToLabels = (points, labels) => {
  const valueByWeek = new Map(points.map((point) => [point.x, point.y]));
  return labels.map((week) => ({ x: week, y: valueByWeek.has(week) ? valueByWeek.get(week) : null }));
};

/** Finds the furthest-out continuous week covered by either the ground truth or the forecast horizon. */
const getMaxContinuousWeek = (currentSeries, horizonDates) => {
  const continuousWeeks = [
    ...currentSeries.map((entry) => getContinuousWeekFromDate(entry.date)),
    ...horizonDates.map((date) => getContinuousWeekFromDate(date)),
  ].filter((week) => week !== null);

  return continuousWeeks.length > 0 ? Math.max(...continuousWeeks) : CONTINUOUS_SEASON_LAST_WEEK;
};

// =============================================================================
// Forecast-entry helpers
// =============================================================================

const getMedian = (entry) => entry?.median ?? 0;
const getWidth80 = (entry) => entry?.width80 ?? 0;
const getUpper80 = (entry) => entry?.upper80 ?? getMedian(entry) + getWidth80(entry);
const getLower80 = (entry) => entry?.lower80 ?? Math.max(0, getMedian(entry) - getWidth80(entry));

// =============================================================================
// Component
// =============================================================================

/**
 * Interactive forecast chart: plots current/past season ground truth plus
 * a draggable median forecast line and 80% interval handles, or (in scoring
 * mode) the submitted forecast against other models and the eventual outcome.
 *
 * @param {{date: string, value: number}[]} groundTruthSeries - current season observed values
 * @param {{date: string, value: number}[]} previousSeasonSeries - previous season observed values, for overlay
 * @param {{date: string, value: number}[]} twoBeforeSeasonSeries - season before the previous one (shown with showMoreSeasons)
 * @param {{date: string, value: number}[]} threeBeforeSeasonSeries - season before that (shown with showMoreSeasons)
 * @param {{current?: string, previous?: string, twoBefore?: string, threeBefore?: string}} [seasonLabels] - season names for the legend, e.g. "2025/26"
 * @param {boolean} [showMoreSeasons=false] - also overlay the two older seasons
 * @param {string[]} horizonDates - "YYYY-WXX" weeks being forecast
 * @param {{median?: number, width80?: number, upper80?: number, lower80?: number}[]} entries - one forecast entry per horizon date
 * @param {number} maxValue - a hard floor for the y-axis max (e.g. from other charts, for visual consistency)
 * @param {(index: number, field: 'median' | 'interval80', value: number | [number, number]) => void} onAdjust - called while dragging a handle
 * @param {number} [height=380]
 * @param {boolean} [showIntervals=true] - whether to render the 80% interval band/handles
 * @param {boolean} [zoomedView=false] - true: show only the last 5 weeks + horizon; false: show the full season
 * @param {{groundTruth?: number[], models?: {modelName: string}[]}} [scores] - actuals + model list, used only when showScoring
 * @param {boolean} [showScoring=false] - switches the chart from "editable forecast" mode to "results/scoring" mode
 * @param {Object.<string, {predictions: Object}>} [modelForecasts={}] - per-model prediction data, keyed by model name
 * @param {number[]} [horizons=[]] - horizon indices used to look up predictions in modelForecasts
 */
const ForecastleChartCanvasInner = ({
  groundTruthSeries = [],
  previousSeasonSeries = [],
  twoBeforeSeasonSeries = [],
  threeBeforeSeasonSeries = [],
  seasonLabels: seasonNames = null,
  showMoreSeasons = false,
  horizonDates = [],
  entries = [],
  maxValue,
  onAdjust,
  height = 380,
  showIntervals = true,
  zoomedView = false,
  scores = null,
  showScoring = false,
  modelForecasts = {},
  horizons = [],
}) => {
  const chartRef = useRef(null);
  const [dragState, setDragState] = useState(null);

  // Touch screens need bigger handles and a larger hit area than a mouse pointer.
  const isTouch = useMemo(
    () => (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) ?? false,
    [],
  );
  const medianHandleRadius = isTouch ? 11 : 8;
  const intervalHandleRadius = isTouch ? 9 : 6;
  const handleHitRadius = isTouch ? 28 : 15;

  // Initial y-axis max, computed once so the axis doesn't jump around as the
  // user drags handles. (The visible past seasons can raise it, see yAxisMax below.)
  const [fixedYMax] = useState(() => {
    const entryMax = Math.max(maxValue, ...entries.map((entry) => getMedian(entry) + getWidth80(entry)));
    return entryMax > 0 ? entryMax * 1.1 : 1;
  });

  // x-axis range: either the full season, or (in zoomedView) just the last 5
  // ground-truth weeks through the end of the forecast horizon.
  const xAxisRange = useMemo(() => {
    const fullMinWeek = CURRENT_SEASON_FIRST_WEEK;
    // Leave room for the extra previous-season weeks (only if there is a previous season)
    const extraWeeks = previousSeasonSeries.length > 0 ? FORECASTLE_CONFIG.previousSeasonExtraWeeks : 0;
    const withExtra = (week) => Math.min(week + extraWeeks, CONTINUOUS_SEASON_LAST_WEEK);

    if (!zoomedView) {
      return { min: fullMinWeek, max: FULL_VIEW_LAST_WEEK };
    }

    const recentGroundTruth = groundTruthSeries.slice(-5);
    const maxRecentWeek = getMaxContinuousWeek(recentGroundTruth, horizonDates);
    const firstRecentWeek = recentGroundTruth.length > 0
      ? getContinuousWeekFromDate(recentGroundTruth[0].date)
      : null;

    return { min: firstRecentWeek ?? fullMinWeek, max: withExtra(maxRecentWeek) };
  }, [groundTruthSeries, previousSeasonSeries, horizonDates, zoomedView]);

  const seasonLabels = useMemo(() => buildSeasonLabels(), []);

  const currentSeasonByWeek = useMemo(
    () => mapDataToContinuousWeeks(groundTruthSeries),
    [groundTruthSeries],
  );
  const previousSeasonByWeek = useMemo(
    () => mapDataToContinuousWeeks(previousSeasonSeries),
    [previousSeasonSeries],
  );
  const twoBeforeSeasonByWeek = useMemo(
    () => mapDataToContinuousWeeks(twoBeforeSeasonSeries),
    [twoBeforeSeasonSeries],
  );
  const threeBeforeSeasonByWeek = useMemo(
    () => mapDataToContinuousWeeks(threeBeforeSeasonSeries),
    [threeBeforeSeasonSeries],
  );

  const currentSeasonDataset = useMemo(
    () => alignPointsToLabels(currentSeasonByWeek, seasonLabels),
    [currentSeasonByWeek, seasonLabels],
  );
  const previousSeasonDataset = useMemo(
    () => alignPointsToLabels(previousSeasonByWeek, seasonLabels),
    [previousSeasonByWeek, seasonLabels],
  );
  const twoBeforeSeasonDataset = useMemo(
    () => alignPointsToLabels(twoBeforeSeasonByWeek, seasonLabels),
    [twoBeforeSeasonByWeek, seasonLabels],
  );
  const threeBeforeSeasonDataset = useMemo(
    () => alignPointsToLabels(threeBeforeSeasonByWeek, seasonLabels),
    [threeBeforeSeasonByWeek, seasonLabels],
  );

  // Past-season overlays, drawn oldest first so the newer seasons (and the current
  // season) end up on top. The legend shows them in the reverse order (newest first).
  const pastSeasonLayers = useMemo(
    () => [
      {
        key: 'threeBefore',
        label: seasonNames?.threeBefore ?? 'Three Seasons Ago',
        series: threeBeforeSeasonSeries,
        dataset: threeBeforeSeasonDataset,
        visible: showMoreSeasons,
        markers: false,
      },
      {
        key: 'twoBefore',
        label: seasonNames?.twoBefore ?? 'Two Seasons Ago',
        series: twoBeforeSeasonSeries,
        dataset: twoBeforeSeasonDataset,
        visible: showMoreSeasons,
        markers: false,
      },
      {
        key: 'previous',
        label: seasonNames?.previous ?? 'Previous Season',
        series: previousSeasonSeries,
        dataset: previousSeasonDataset,
        visible: true,
        // With only one past season there is no clutter, so keep the markers
        markers: !showMoreSeasons,
      },
    ],
    [
      seasonNames,
      showMoreSeasons,
      threeBeforeSeasonSeries,
      threeBeforeSeasonDataset,
      twoBeforeSeasonSeries,
      twoBeforeSeasonDataset,
      previousSeasonSeries,
      previousSeasonDataset,
    ],
  );

  // y-axis max: the initial value, raised if a visible season (within the visible
  // x-range) would otherwise be cut off. Dragging handles never changes this.
  const yAxisMax = useMemo(() => {
    const visiblePoints = [
      ...currentSeasonByWeek,
      ...previousSeasonByWeek,
      ...(showMoreSeasons ? [...twoBeforeSeasonByWeek, ...threeBeforeSeasonByWeek] : []),
    ];
    let seasonMax = 0;
    visiblePoints.forEach((point) => {
      if (Number.isFinite(point.y) && point.x >= xAxisRange.min && point.x <= xAxisRange.max) {
        seasonMax = Math.max(seasonMax, point.y);
      }
    });
    return Math.max(fixedYMax, seasonMax * 1.1);
  }, [
    fixedYMax,
    xAxisRange,
    showMoreSeasons,
    currentSeasonByWeek,
    previousSeasonByWeek,
    twoBeforeSeasonByWeek,
    threeBeforeSeasonByWeek,
  ]);

  // The last observed point ("present"): the 80% band starts here, like the median line.
  const presentPoint = useMemo(() => {
    const last = groundTruthSeries[groundTruthSeries.length - 1];
    if (!last) return null;
    const x = getContinuousWeekFromDate(last.date);
    return x === null ? null : { x, y: last.value };
  }, [groundTruthSeries]);

  // 80% interval band endpoints: the present point, then one point per horizon date.
  const interval80Upper = useMemo(() => {
    const points = horizonDates.map((date, idx) => ({
      x: getContinuousWeekFromDate(date),
      y: getUpper80(entries[idx]),
    }));
    return presentPoint ? [presentPoint, ...points] : points;
  }, [entries, horizonDates, presentPoint]);

  const interval80Lower = useMemo(() => {
    const points = horizonDates.map((date, idx) => ({
      x: getContinuousWeekFromDate(date),
      y: getLower80(entries[idx]),
    }));
    return presentPoint ? [presentPoint, ...points] : points;
  }, [entries, horizonDates, presentPoint]);

  // Median forecast line: starts at the last known ground-truth point (so it
  // connects visually) and continues through each horizon date.
  const medianData = useMemo(() => {
    const data = [];
    const lastGroundTruth = groundTruthSeries[groundTruthSeries.length - 1];
    if (lastGroundTruth) {
      const lastContinuousWeek = getContinuousWeekFromDate(lastGroundTruth.date);
      if (lastContinuousWeek !== null) {
        data.push({ x: lastContinuousWeek, y: lastGroundTruth.value });
      }
    }
    horizonDates.forEach((date, idx) => {
      data.push({ x: getContinuousWeekFromDate(date), y: getMedian(entries[idx]) });
    });
    return data;
  }, [entries, horizonDates, groundTruthSeries]);

  // Draggable median handles (one per horizon date).
  const medianHandles = useMemo(
    () =>
      horizonDates.map((date, idx) => ({
        x: getContinuousWeekFromDate(date),
        y: getMedian(entries[idx]),
        meta: { index: idx, type: 'median' },
        radius: medianHandleRadius,
      })),
    [entries, horizonDates, medianHandleRadius],
  );

  // Draggable 80% interval handles (upper + lower per horizon date).
  const intervalHandles = useMemo(() => {
    if (!showIntervals) return [];
    return horizonDates.flatMap((date, idx) => {
      const continuousWeek = getContinuousWeekFromDate(date);
      return [
        { x: continuousWeek, y: getUpper80(entries[idx]), meta: { index: idx, type: 'upper80' }, radius: intervalHandleRadius },
        { x: continuousWeek, y: getLower80(entries[idx]), meta: { index: idx, type: 'lower80' }, radius: intervalHandleRadius },
      ];
    });
  }, [entries, horizonDates, showIntervals, intervalHandleRadius]);

  // --- Drag-to-adjust interaction -------------------------------------------------
  // Chart.js doesn't offer built-in draggable points, so pointer events are
  // wired up manually on the underlying canvas: pointerdown picks the nearest
  // handle (if any), pointermove converts the cursor's y-pixel to a data
  // value and reports it via onAdjust, pointerup ends the drag.
  useEffect(() => {
    const chart = chartRef.current;
    const canvas = chart?.canvas;
    if (!canvas) return undefined;

    const getHandleMeta = (activeElement) => {
      if (!activeElement) return null;
      const dataset = chart.data.datasets[activeElement.datasetIndex];
      if (dataset?.label === 'Median Handles') {
        return medianHandles[activeElement.index]?.meta ?? null;
      }
      if (dataset?.label === 'Interval Handles') {
        return intervalHandles[activeElement.index]?.meta ?? null;
      }
      return null;
    };

    // Looks at everything under the pointer and returns the closest *handle*. Season
    // lines are also hit-testable (for tooltips), so a plain "nearest element"
    // lookup could pick a season point sitting next to a handle and block the drag.
    const findHandleAtEvent = (event) => {
      const elements = chart.getElementsAtEventForMode(event, 'point', { intersect: true }, false);
      if (!elements?.length) return null;
      const position = getRelativePosition(event, chart);
      let bestMeta = null;
      let bestDistance = Infinity;
      elements.forEach((element) => {
        const meta = getHandleMeta(element);
        if (!meta) return;
        const distance = Math.hypot(element.element.x - position.x, element.element.y - position.y);
        if (distance < bestDistance) {
          bestMeta = meta;
          bestDistance = distance;
        }
      });
      return bestMeta;
    };

    let animationFrame = null;

    const pointerMove = (event) => {
      if (!dragState) return;
      event.preventDefault();
      if (animationFrame) cancelAnimationFrame(animationFrame);

      animationFrame = requestAnimationFrame(() => {
        const yScale = chart.scales.y;
        const bounds = canvas.getBoundingClientRect();
        const offsetY = event.clientY - bounds.top;
        const roundedValue = Math.round(Math.max(0, yScale.getValueForPixel(offsetY)));

        if (dragState.type === 'median') {
          onAdjust(dragState.index, 'median', roundedValue);
        } else if (dragState.type === 'upper80') {
          const entry = entries[dragState.index];
          onAdjust(dragState.index, 'interval80', [getLower80(entry), roundedValue]);
        } else if (dragState.type === 'lower80') {
          const entry = entries[dragState.index];
          onAdjust(dragState.index, 'interval80', [roundedValue, getUpper80(entry)]);
        }
      });
    };

    const pointerUp = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      setDragState(null);
    };

    const pointerDown = (event) => {
      const meta = findHandleAtEvent(event);
      if (!meta) {
        setDragState(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDragState(meta);
    };

    // On touch screens the page must still scroll when the finger starts on the chart,
    // except when it starts on a handle (that gesture is a drag).
    const touchStart = (event) => {
      if (findHandleAtEvent(event)) event.preventDefault();
    };

    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('touchstart', touchStart, { passive: false });
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    return () => {
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('touchstart', touchStart);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerUp);
    };
  }, [dragState, onAdjust, entries, medianHandles, intervalHandles]);

  // --- Scoring-mode datasets -------------------------------------------------

  const groundTruthForecastPoints = useMemo(() => {
    if (!showScoring || !scores?.groundTruth) return [];
    return horizonDates
      .map((date, idx) => ({ x: getContinuousWeekFromDate(date), y: scores.groundTruth[idx] }))
      .filter((point) => point.x !== null && point.y !== null);
  }, [showScoring, scores, horizonDates]);

  const topModelForecasts = useMemo(() => {
    if (!showScoring || !scores?.models) return [];

    return scores.models
      .slice(0, 3)
      .map((model, idx) => {
        const modelData = modelForecasts[model.modelName];
        if (!modelData?.predictions) return null;

        const modelMedians = horizons.map((horizon) => {
          const horizonPrediction = modelData.predictions[String(horizon)];
          const { quantiles, values } = horizonPrediction ?? {};
          if (!quantiles || !values || quantiles.length !== values.length) return null;

          const medianIndex = quantiles.findIndex((q) => Math.abs(q - 0.5) < 0.001);
          return medianIndex === -1 ? null : values[medianIndex];
        });

        const isHub = /hub|ensemble/i.test(model.modelName);
        const color = isHub
          ? 'rgba(34, 139, 34, 0.8)'
          : ['rgba(30, 144, 255, 0.8)', 'rgba(255, 99, 71, 0.6)', 'rgba(255, 165, 0, 0.6)'][idx] ?? 'rgba(128, 128, 128, 0.6)';

        return {
          modelName: model.modelName,
          color,
          data: horizonDates
            .map((date, horizonIdx) => ({ x: getContinuousWeekFromDate(date), y: modelMedians[horizonIdx] }))
            .filter((point) => point.x !== null && Number.isFinite(point.y)),
        };
      })
      .filter(Boolean);
  }, [showScoring, scores, horizonDates, modelForecasts, horizons]);

  // --- Chart.js data/options ---------------------------------------------------

  const chartData = useMemo(() => {
    const datasets = [];

    // Past seasons first (oldest at the bottom), then the current season on top of them.
    pastSeasonLayers
      .filter((layer) => layer.visible && layer.series.length > 0)
      .forEach((layer) => {
        const style = PAST_SEASON_STYLES[layer.key];
        datasets.push({
          type: 'line',
          label: layer.label,
          isSeason: true,
          data: layer.dataset,
          parsing: false,
          tension: 0,
          spanGaps: true,
          borderColor: style.color,
          backgroundColor: style.color,
          borderWidth: style.width,
          borderDash: style.dash,
          // No markers when several seasons are shown (less clutter); a small hit
          // radius keeps the tooltips working.
          pointRadius: layer.markers ? 3 : 0,
          pointHoverRadius: 5,
          pointHitRadius: 6,
          pointBackgroundColor: style.color,
          pointBorderColor: COLORS.white,
          pointBorderWidth: 1,
        });
      });

    datasets.push({
      type: 'line',
      label: `${seasonNames?.current ?? 'Current Season'}${seasonNames?.current ? ' (current)' : ''}`,
      isSeason: true,
      data: currentSeasonDataset,
      parsing: false,
      tension: 0,
      spanGaps: true,
      borderColor: COLORS.median,
      backgroundColor: COLORS.median,
      borderWidth: 2.5,
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: COLORS.median,
      pointBorderColor: COLORS.white,
      pointBorderWidth: 1,
    });

    if (showIntervals) {
      // The invisible "lower" line establishes the bottom edge that the
      // "upper" line's `fill: '-1'` shades against, forming the band.
      datasets.push(
        {
          type: 'line',
          label: '80% lower',
          data: interval80Lower,
          parsing: false,
          tension: 0,
          borderColor: 'transparent',
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false,
        },
        {
          type: 'line',
          label: '80% interval',
          data: interval80Upper,
          parsing: false,
          tension: 0,
          borderColor: 'transparent',
          backgroundColor: `${COLORS.interval80}80`,
          borderWidth: 0,
          pointRadius: 0,
          fill: '-1',
        },
      );
    }

    if (showScoring && groundTruthForecastPoints.length > 0) {
      const fullGroundTruthLine = [
        ...currentSeasonDataset.filter((point) => point.y !== null),
        ...groundTruthForecastPoints,
      ];
      datasets.push({
        type: 'line',
        label: 'Ground Truth',
        data: fullGroundTruthLine,
        parsing: false,
        tension: 0,
        spanGaps: false,
        borderColor: COLORS.median,
        backgroundColor: COLORS.median,
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: COLORS.median,
        pointBorderColor: COLORS.white,
        pointBorderWidth: 1,
      });
    }

    datasets.push({
      type: 'line',
      label: showScoring ? 'Your Forecast' : 'Median',
      data: medianData,
      parsing: false,
      tension: 0,
      borderColor: showScoring ? COLORS.scoringForecast : COLORS.median,
      backgroundColor: showScoring ? COLORS.scoringForecast : COLORS.median,
      borderWidth: 3,
      pointRadius: showScoring ? 5 : 0,
      pointBackgroundColor: showScoring ? COLORS.scoringForecast : COLORS.handleMedian,
      pointBorderColor: showScoring ? COLORS.white : COLORS.handleOutline,
      pointBorderWidth: showScoring ? 1 : 2,
      borderDash: [5, 5],
    });

    if (showScoring) {
      topModelForecasts.forEach((model) => {
        datasets.push({
          type: 'line',
          label: model.modelName,
          data: model.data,
          parsing: false,
          tension: 0,
          borderColor: model.color,
          backgroundColor: model.color,
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: model.color,
          pointBorderColor: COLORS.white,
          pointBorderWidth: 1,
          borderDash: [5, 5],
        });
      });
    } else {
      datasets.push({
        type: 'scatter',
        label: 'Median Handles',
        data: medianHandles,
        parsing: false,
        pointBackgroundColor: COLORS.handleMedian,
        pointBorderColor: COLORS.handleOutline,
        pointBorderWidth: 2,
        pointHoverRadius: medianHandleRadius + 2,
        pointRadius: medianHandleRadius,
        showLine: false,
        hitRadius: handleHitRadius,
      });

      if (showIntervals && intervalHandles.length > 0) {
        datasets.push({
          type: 'scatter',
          label: 'Interval Handles',
          data: intervalHandles,
          parsing: false,
          // Handle points always carry `meta`, so this is effectively a flat color;
          // kept as a callback in case per-handle styling is added later.
          pointBackgroundColor: 'rgba(220, 20, 60, 0.5)',
          pointBorderColor: COLORS.handleOutline,
          pointBorderWidth: 2,
          pointHoverRadius: intervalHandleRadius + 2,
          pointRadius: (context) => intervalHandles[context.dataIndex]?.radius ?? intervalHandleRadius,
          showLine: false,
          hitRadius: handleHitRadius,
        });
      }
    }

    return { datasets, labels: seasonLabels };
  }, [
    pastSeasonLayers,
    seasonNames,
    currentSeasonDataset,
    medianHandles,
    intervalHandles,
    interval80Upper,
    interval80Lower,
    medianData,
    seasonLabels,
    showIntervals,
    showScoring,
    groundTruthForecastPoints,
    topModelForecasts,
    medianHandleRadius,
    intervalHandleRadius,
    handleHitRadius,
  ]);

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        intersect: true,
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          // Datasets are ordered oldest season first (drawing order); the legend lists
          // the seasons newest first. (Not reversed in scoring mode.)
          reverse: !showScoring,
          labels: {
            // Normal mode: one entry per season shown (the labels are the season years).
            // Scoring mode: everything except the helper datasets.
            filter: (legendItem, data) => {
              if (showScoring) {
                return !legendItem.text.includes('lower') && !legendItem.text.includes('Handles');
              }
              return Boolean(data.datasets[legendItem.datasetIndex]?.isSeason);
            },
            usePointStyle: true,
            padding: 12,
            font: { size: 11 },
          },
        },
        tooltip: {
          callbacks: {
            title: (context) => {
              const week = context[0]?.raw?.x;
              return week !== undefined ? `Week ${transformContinuousToDisplay(week)}` : '';
            },
            label: (context) => {
              const datasetLabel = context.dataset.label || '';

              if (context.dataset.isSeason) {
                return `${datasetLabel}: ${context.parsed.y?.toLocaleString('en-US') ?? '—'}`;
              }
              if (datasetLabel.includes('interval')) {
                if (Array.isArray(context.raw?.y)) {
                  const [lower, upper] = context.raw.y;
                  return `80% Interval: ${Math.round(lower)} – ${Math.round(upper)}`;
                }
                return datasetLabel;
              }
              if (datasetLabel === 'Median' || datasetLabel === 'Median Handles') {
                return `Median: ${Math.round(context.parsed.y)}`;
              }
              return datasetLabel;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: xAxisRange.min,
          max: xAxisRange.max,
          ticks: {
            color: '#000000',
            stepSize: 4,
            callback: (value) => transformContinuousToDisplay(value),
          },
          title: {
            display: true,
            text: zoomedView ? 'Calendar Week (Recent Weeks + Horizon)' : 'Calendar Week (Full Season)',
            font: { size: 12, weight: 'bold' },
          },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          max: yAxisMax,
          ticks: {
            color: '#000000',
            callback: (value) => Math.round(value).toLocaleString('en-US'),
          },
          grid: { color: 'rgba(0, 0, 0, 0.08)' },
        },
      },
      layout: {
        padding: { right: 12, left: 12 },
      },
    }),
    [yAxisMax, showScoring, xAxisRange, zoomedView],
  );

  return (
    <div
      style={{
        width: '100%',
        height,
        touchAction: 'pan-y',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        MozUserSelect: 'none',
        msUserSelect: 'none',
      }}
    >
      <Chart ref={chartRef} type="line" data={chartData} options={options} />
    </div>
  );
};

const ForecastleChartCanvas = memo(ForecastleChartCanvasInner);
ForecastleChartCanvas.displayName = 'ForecastleChartCanvas';

export default ForecastleChartCanvas;