import { useMemo, useState, useEffect, useCallback } from 'react';
import { Group, NumberInput, RangeSlider, Stack, Text, Slider, SegmentedControl } from '@mantine/core';

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
  const [intervalMode, setIntervalMode] = useState('auto'); // 'auto' or 'manual'
  const [width80, setWidth80] = useState(autoParams.width80);
  const [growth80, setGrowth80] = useState(autoParams.growth80);
  const [isSliding, setIsSliding] = useState(false); // Track if user is actively sliding

  // Update state when entries change, but only if not currently sliding and in auto mode
  useEffect(() => {
    if (!isSliding && intervalMode === 'auto') {
      const params = calculateAutoIntervalParams();
      setWidth80(params.width80);
      setGrowth80(params.growth80);
    }
  }, [entries, isSliding, intervalMode, calculateAutoIntervalParams]);

  const updateEntry = (index, field, value) => {
    const nextEntries = entries.map((entry, idx) => {
      if (idx !== index) return entry;
      const nextEntry = { ...entry };
      if (field === 'median') {
        nextEntry.median = Math.max(0, value);
      } else if (field === 'interval80') {
        // Two-point slider for 80% interval
        const [lower, upper] = value;
        nextEntry.lower80 = Math.max(0, lower);
        nextEntry.upper80 = Math.max(lower, upper);
        // Update width for backward compatibility
        nextEntry.width80 = Math.max(nextEntry.upper80 - entry.median, entry.median - nextEntry.lower80);
      }
      return nextEntry;
    });
    onChange(nextEntries);
  };

  // In median mode, show only median controls
  if (mode === 'median') {
    return (
      <Group align="flex-start" gap="lg" wrap="wrap">
        {entries.map((entry, index) => (
          <Stack key={horizonDates[index] || `horizon-${index}`} gap="xs" style={{ minWidth: 160 }}>
            <Text size="sm" fw={600} ta="center">
              {/* ✅ Show YYYY-WXX label */}
              {formatWeekLabel(horizonDates[index])}
            </Text>
            {/* Median */}
            <Stack gap={4}>
              <Text size="xs" c="dimmed" fw={500}>Median Forecast</Text>
              <NumberInput
                value={entry.median}
                onChange={(val) => updateEntry(index, 'median', val)}
                min={0}
                max={sliderMax}
                step={10}
                size="sm"
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

  // In intervals mode, show auto interval controls + advanced section
  return (
    <Stack gap="lg">
      {/* Mode Toggle */}
      <SegmentedControl
        value={intervalMode}
        onChange={setIntervalMode}
        data={[
          { label: 'Auto 80% Interval', value: 'auto' },
          { label: 'Manual 80% Interval', value: 'manual' },
        ]}
        fullWidth
        color="red"
        size="sm"
      />
      {intervalMode === 'auto' ? (
        /* Auto Interval Controls */
        <Stack gap="md">
          <Text size="sm" fw={600}>Auto 80% Interval</Text>
          {/* 80% Interval Width */}
          <Stack gap="xs">
            <Group justify="space-between" align="center">
              <Text size="xs" fw={500} c="dimmed">80% Interval Width</Text>
              <Text size="xs" fw={600}>{Math.round(width80)}</Text>
            </Group>
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
              disabled={disabled}
              marks={[
                { value: 0, label: '0' },
                { value: sliderMax / 4, label: `${Math.round(sliderMax / 4)}` },
                { value: sliderMax / 2, label: `${Math.round(sliderMax / 2)}` },
              ]}
            />
          </Stack>
          {/* 80% Growth per Week */}
          <Stack gap="xs">
  <Group justify="space-between" align="center">
    <Text size="xs" fw={500} c="dimmed">80% Growth per Week</Text>
    <Text size="xs" fw={600}>{Math.round(growth80)}%</Text>
  </Group>
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
    disabled={disabled}
    marks={[
      { value: -50, label: '-50%' },
      { value: 0, label: '0%' },
      { value: 100, label: '100%' },
      { value: 200, label: '200%' },
    ]}
  />
</Stack>
          {/* Preview of applied intervals */}
          <Stack gap="xs" mt="md">
            <Text size="xs" fw={500} c="dimmed">Preview</Text>
            <Group gap="xs" wrap="wrap">
              {entries.map((entry, index) => (
                <Stack key={horizonDates[index] || `preview-${index}`} gap={2} style={{ minWidth: 90 }}>
                  <Text size="xs" c="dimmed" ta="center">
                    {formatWeekLabel(horizonDates[index])}
                  </Text>
                  <Text size="xs" fw={500} ta="center" c="red.7">
                    80%: [{Math.round(entry.lower80)}, {Math.round(entry.upper80)}]
                  </Text>
                </Stack>
              ))}
            </Group>
          </Stack>
        </Stack>
      ) : (
        /* Manual - Detailed Sliders */
        <Stack gap="md">
          <Text size="sm" fw={600} mb="xs">Manual 80% Interval</Text>
          <Group align="flex-start" gap="lg" wrap="wrap">
            {entries.map((entry, index) => (
              <Stack key={horizonDates[index] || `manual-${index}`} gap="xs" style={{ minWidth: 200 }}>
                <Text size="sm" fw={600} ta="center">
                  {/* ✅ Show YYYY-WXX label */}
                  {formatWeekLabel(horizonDates[index])}
                </Text>
                <Text size="xs" c="dimmed" ta="center">
                  Median: <Text component="span" fw={600}>{Math.round(entry.median)}</Text>
                </Text>
                {/* 80% Interval - Two-point range slider */}
                <Stack gap={4}>
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">80% Interval</Text>
                    <Text size="xs" fw={500}>
                      [{Math.round(entry.lower80)}, {Math.round(entry.upper80)}]
                    </Text>
                  </Group>
                  <RangeSlider
                    value={[entry.lower80, entry.upper80]}
                    onChange={(val) => updateEntry(index, 'interval80', val)}
                    min={0}
                    max={sliderMax}
                    step={1}
                    color="red"
                    size="sm"
                    minRange={0}
                    disabled={disabled}
                    marks={[
                      { value: 0, label: '0' },
                      { value: entry.median, label: `${Math.round(entry.median)}` },
                      { value: sliderMax, label: `${Math.round(sliderMax)}` },
                    ]}
                  />
                  <Text size="xs" c="dimmed" ta="center">
                    Range: {Math.round(entry.upper80 - entry.lower80)}
                  </Text>
                </Stack>
              </Stack>
            ))}
          </Group>
        </Stack>
      )}
    </Stack>
  );
};

export default ForecastleInputControls;