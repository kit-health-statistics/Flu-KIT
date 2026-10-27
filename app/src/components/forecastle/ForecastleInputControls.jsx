import { useMemo, useState, useEffect, useCallback } from 'react';
import { Group, NumberInput, Stack, Text, Slider } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';

// ✅ Helper: Format YYYY-WXX for display (optional — you can customize)
const formatWeekLabel = (weekStr) => {
  if (!weekStr || typeof weekStr !== 'string') return weekStr;
  const match = weekStr.match(/^(\d{4})-W(\d{1,2})$/);
  if (!match) return weekStr;
  const [, year, week] = match;
  return `W${week} ${year}`;
};

// ✅ NEW: Accept horizonDates prop — array of YYYY-WXX strings
const ForecastleInputControls = ({
  entries,
  onChange,
  maxValue,
  mode = 'intervals',
  disabled = false,
  horizonDates = [], // ✅ NEW: Pass from parent — e.g., ['2025-W03', '2025-W04', ...]
}) => {
  const isMobile = useMediaQuery('(max-width: 48em)');
  const sliderMax = useMemo(() => Math.max(maxValue, 1), [maxValue]);

  // Calculate initial auto interval values from current entries
  const calculateAutoIntervalParams = useCallback(() => {
    if (entries.length === 0) return { width80: 0, growth80: 0 };
    const firstEntry = entries[0];
    const width80 = (firstEntry.upper80 - firstEntry.lower80) / 2;
    if (entries.length > 1) {
      const lastEntry = entries[entries.length - 1];
      const lastWidth80 = (lastEntry.upper80 - lastEntry.lower80) / 2;
      const horizonDiff = lastEntry.horizon - firstEntry.horizon;
      const growth80 = (horizonDiff > 0 && width80 > 0)
        ? ((lastWidth80 / width80 - 1) / horizonDiff) * 100
        : 0;
      return { width80, growth80 };
    }
    return { width80, growth80: 0 };
  }, [entries]);

  const autoParams = useMemo(() => calculateAutoIntervalParams(), [calculateAutoIntervalParams]);
  const [width80, setWidth80] = useState(autoParams.width80);
  const [growth80, setGrowth80] = useState(autoParams.growth80);
  const [isSliding, setIsSliding] = useState(false); // Track if user is actively sliding

  // Keep the sliders in sync with the entries (e.g. after dragging a handle in the chart),
  // but not while the user is actively sliding
  useEffect(() => {
    if (!isSliding) {
      const params = calculateAutoIntervalParams();
      setWidth80(params.width80);
      setGrowth80(params.growth80);
    }
  }, [entries, isSliding, calculateAutoIntervalParams]);

  const updateMedian = (index, value) => {
    const nextEntries = entries.map((entry, idx) =>
      idx === index ? { ...entry, median: Math.max(0, value) } : entry,
    );
    onChange(nextEntries);
  };

  // In median mode, show only median controls
  if (mode === 'median') {
    return (
      <Group align="flex-start" gap={isMobile ? 'sm' : 'lg'} wrap="wrap">
        {entries.map((entry, index) => (
          // flex-basis instead of a fixed minWidth, so blocks wrap to fit narrow screens
          <Stack key={horizonDates[index] || `horizon-${index}`} gap="xs" style={{ flex: '1 1 140px', minWidth: 0 }}>
            <Text size="sm" fw={600} ta="center">
              {/* ✅ Show YYYY-WXX label */}
              {formatWeekLabel(horizonDates[index])}
            </Text>
            {/* Median */}
            <Stack gap={4}>
              <Text size="xs" c="dimmed" fw={500}>Median Forecast</Text>
              <NumberInput
                value={entry.median}
                onChange={(val) => updateMedian(index, val)}
                min={0}
                max={sliderMax}
                step={10}
                size={isMobile ? 'md' : 'sm'}
                inputMode="numeric"
                disabled={disabled}
              />
            </Stack>
          </Stack>
        ))}
      </Group>
    );
  }

  // Apply auto interval to all horizons
  const applyAutoInterval = (baseWidth80, growthPercent) => {
    const nextEntries = entries.map((entry, idx) => {
      const horizonIndex = idx;
      const currentWidth80 = Math.max(0, baseWidth80 * (1 + (growthPercent / 100) * horizonIndex));
      return {
        ...entry,
        lower80: Math.max(0, entry.median - currentWidth80),
        upper80: entry.median + currentWidth80,
        width80: currentWidth80,
      };
    });
    onChange(nextEntries);
  };

  // In intervals mode, show the interval width / growth sliders and a preview.
  // Individual bounds can still be adjusted by dragging the handles in the chart.
  return (
    <Stack gap="md">
      <Text size="sm" fw={600}>80% Interval</Text>
      {/* 80% Interval Width */}
      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Text size="xs" fw={500} c="dimmed">80% Interval Width</Text>
          <Text size="xs" fw={600}>{Math.round(width80)}</Text>
        </Group>
        {/* px keeps the first/last mark labels inside the screen */}
        <Stack px="md" pb="lg">
          <Slider
            value={width80}
            onChange={(val) => {
              setWidth80(val);
              applyAutoInterval(val, growth80);
            }}
            onChangeEnd={() => setIsSliding(false)}
            onMouseDown={() => setIsSliding(true)}
            onTouchStart={() => setIsSliding(true)}
            min={0}
            max={sliderMax / 2}
            step={1}
            color="red"
            size="md"
            thumbSize={isMobile ? 24 : undefined}
            disabled={disabled}
            marks={[
              { value: 0, label: '0' },
              { value: sliderMax / 4, label: `${Math.round(sliderMax / 4)}` },
              { value: sliderMax / 2, label: `${Math.round(sliderMax / 2)}` },
            ]}
          />
        </Stack>
      </Stack>
      {/* 80% Growth per Week */}
      <Stack gap="xs">
        <Group justify="space-between" align="center">
          <Text size="xs" fw={500} c="dimmed">80% Growth per Week</Text>
          <Text size="xs" fw={600}>{Math.round(growth80)}%</Text>
        </Group>
        <Stack px="md" pb="lg">
          <Slider
            value={growth80}
            onChange={(val) => {
              setGrowth80(val);
              applyAutoInterval(width80, val);
            }}
            onChangeEnd={() => setIsSliding(false)}
            onMouseDown={() => setIsSliding(true)}
            onTouchStart={() => setIsSliding(true)}
            min={-50}
            max={200}
            step={5}
            color="red"
            size="md"
            thumbSize={isMobile ? 24 : undefined}
            disabled={disabled}
            marks={[
              { value: -50, label: '-50%' },
              { value: 0, label: '0%' },
              { value: 100, label: '100%' },
              { value: 200, label: '200%' },
            ]}
          />
        </Stack>
    </Stack>
  );
};

export default ForecastleInputControls;