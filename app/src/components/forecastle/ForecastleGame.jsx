import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import {
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Stepper,
  Switch,
  Text,
  ThemeIcon,
  Title,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconTarget,
  IconCopy,
  IconCheck,
  IconRefresh,
} from '@tabler/icons-react';
import { initialiseForecastInputs, convertToIntervals } from '../../utils/forecastleInputs';
import { validateForecastSubmission } from '../../utils/forecastleValidation';
import { FORECASTLE_CONFIG } from '../../config';
import { extractGroundTruthForHorizons } from '../../utils/forecastleScoring';
import { saveForecastleGame, getForecastleGame, canSubmitForecast, buildGameId } from '../../utils/respilensStorage';
import ForecastleChartCanvas from './ForecastleChartCanvas';
import ForecastleInputControls from './ForecastleInputControls';

// ✅ Helper: Get ISO week number (1-53) for a given Date
const getISOWeek = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Thursday in current week determines the year
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return weekNo;
};

// ✅ Helper: Convert YYYY-WXX to human-readable week range (e.g., "Jan 13–19, 2025")
const getWeekDateRange = (weekStr) => {
  if (!weekStr || typeof weekStr !== 'string') return 'Unknown Date Range';
  const match = weekStr.match(/^(\d{4})-W(\d{1,2})$/);
  if (!match) return 'Invalid Week Format';
  const [, year, week] = match;
  const yearNum = parseInt(year, 10);
  const weekNum = parseInt(week, 10);
  if (isNaN(yearNum) || isNaN(weekNum) || weekNum < 1 || weekNum > 53) return 'Invalid Week';
  const jan1 = new Date(yearNum, 0, 1);
  const dayOfWeek = jan1.getDay();
  const dayNum = (dayOfWeek + 6) % 7;
  const mondayOfWeek1 = new Date(jan1);
  mondayOfWeek1.setDate(jan1.getDate() + (dayNum === 0 ? 0 : 8 - dayNum));
  const monday = new Date(mondayOfWeek1);
  monday.setDate(mondayOfWeek1.getDate() + (weekNum - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  const mondayStr = monday.toLocaleDateString('en-US', options);
  const sundayStr = sunday.toLocaleDateString('en-US', options);
  const mondayMonth = monday.toLocaleDateString('en-US', { month: 'short' });
  const sundayMonth = sunday.toLocaleDateString('en-US', { month: 'short' });
  if (mondayMonth === sundayMonth) {
    return `${mondayMonth} ${monday.getDate()}–${sunday.getDate()}, ${monday.getFullYear()}`;
  } else {
    return `${mondayMonth} ${monday.getDate()}–${sundayMonth} ${sunday.getDate()}, ${monday.getFullYear()}`;
  }
};

// ✅ Helper: Add weeks to YYYY-WXX (returns YYYY-WXX)
const addWeeksToDate = (weekStr, weeks) => {
  if (!weekStr || typeof weekStr !== 'string') return weekStr;
  const match = weekStr.match(/^(\d{4})-W(\d{1,2})$/);
  if (!match) return weekStr;
  const [, year, week] = match;
  const yearNum = parseInt(year, 10);
  const weekNum = parseInt(week, 10);
  if (isNaN(yearNum) || isNaN(weekNum)) return weekStr;
  // Calculate new date by adding weeks
  const date = new Date(yearNum, 0, 1); // Jan 1 of the year
  const dayOfWeek = date.getDay();
  const dayNum = (dayOfWeek + 6) % 7;
  const mondayOfWeek1 = new Date(date);
  mondayOfWeek1.setDate(date.getDate() + (dayNum === 0 ? 0 : 8 - dayNum));
  // Add the specified number of weeks
  const newDate = new Date(mondayOfWeek1);
  newDate.setDate(mondayOfWeek1.getDate() + (weekNum - 1) * 7 + weeks * 7);
  // Calculate ISO week number for the new date
  const newYear = newDate.getFullYear();
  const newWeek = getISOWeek(newDate);
  return `${newYear}-W${newWeek.toString().padStart(2, '0')}`;
};

// ✅ Helper: Get week number from YYYY-WXX (for sorting or comparison)
const getWeekNumber = (weekStr) => {
  const match = weekStr.match(/^(\d{4})-W(\d{1,2})$/);
  if (!match) return 0;
  const [, year, week] = match;
  return parseInt(year, 10) * 100 + parseInt(week, 10);
};

const ForecastleGame = () => {
  const [searchParams] = useSearchParams();
  const playDate = searchParams.get('play_date') || null;
  const [scenario, setScenario] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [forecastEntries, setForecastEntries] = useState([]);
  const [submissionErrors, setSubmissionErrors] = useState({});
  const [submittedPayload, setSubmittedPayload] = useState(null);
  const [inputMode, setInputMode] = useState('median');
  const [zoomedView, setZoomedView] = useState(true);
  const [saveError, setSaveError] = useState(null);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [previousGame, setPreviousGame] = useState(null);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    const loadData = async () => {
      try {
        const response = await fetch('/processed_data/your-data.json');
        if (!response.ok) {
          throw new Error(`Failed to load data: ${response.status}`);
        }
        const rawData = await response.json();
        const { metadata, ground_truth } = rawData;
        const { dates, wk_inc, season } = ground_truth;

        console.log('Raw data loaded:', { dates: dates?.length, wk_inc: wk_inc?.length, season: season?.length });
        console.log('Unique seasons:', [...new Set(season)]);

        // Extract seasons
        const uniqueSeasons = [...new Set(season)];
        const currentSeason = uniqueSeasons[uniqueSeasons.length - 1];
        const previousSeason = uniqueSeasons[uniqueSeasons.length - 2];

        console.log('Current season:', currentSeason);
        console.log('Previous season:', previousSeason);

        // Build current season series
        const currentSeasonSeries = dates.map((date, index) => ({
          date,
          value: wk_inc[index],
          season: season[index],
        })).filter(item => item.season === currentSeason);

        console.log('Current season series length:', currentSeasonSeries.length);

        // ✅ Build previous season series (for grey/red dashed line in background)
        let previousSeasonSeries = [];
        if (previousSeason) {
          previousSeasonSeries = dates.map((date, index) => ({
            date,
            value: wk_inc[index],
            season: season[index],
          })).filter(item => item.season === previousSeason);
        }

        console.log('Previous season series length:', previousSeasonSeries.length);

        // Truncate previous season to horizon + 3 weeks (only if we have data)
        const forecastDateIndex = dates.indexOf(playDate || dates[dates.length - 1]);
        if (forecastDateIndex !== -1 && previousSeasonSeries.length > 0) {
          const horizonWeeks = 3;
          const endIndex = forecastDateIndex + horizonWeeks;
          previousSeasonSeries = previousSeasonSeries.slice(0, endIndex + 1);
          console.log('Truncated previous season series length:', previousSeasonSeries.length);
        }

        const lastGroundTruthDate = dates[dates.length - 1];
        const scenario = {
          challengeDate: playDate || `${new Date().getFullYear()}-W${String(getISOWeek(new Date())).padStart(2, '0')}`,
          forecastDate: lastGroundTruthDate,
          dataset: {
            key: metadata.dataset?.[0] || 'default_dataset',
            label: metadata.dataset?.[0] || 'default',
            targetKey: metadata.hubverse_keys?.targets?.[0] || 'wk_inc',
          },
          location: {
            name: metadata.location_name?.[0] || 'Unknown Location',
          },
          horizons: metadata.hubverse_keys?.horizon || [1, 2, 3, 4],
          groundTruthSeries: currentSeasonSeries,
          previousSeasonSeries,
          fullGroundTruthSeries: dates.map((date, index) => ({ date, value: wk_inc[index] })),
        };

        console.log('Scenario built:', {
          challengeDate: scenario.challengeDate,
          forecastDate: scenario.forecastDate,
          groundTruthSeriesLength: scenario.groundTruthSeries.length,
          previousSeasonSeriesLength: scenario.previousSeasonSeries.length,
          horizons: scenario.horizons,
        });

        setScenario(scenario);

// ← add this block
const horizonDates = scenario.horizons.map((h) => addWeeksToDate(scenario.forecastDate, h));
const id = buildGameId({
  challengeDate: scenario.challengeDate,
  forecastDate: scenario.forecastDate,
  dataset: scenario.dataset.key,
  location: scenario.location.name,
  target: scenario.dataset.targetKey,
});
const currentGroundTruth = extractGroundTruthForHorizons(scenario.fullGroundTruthSeries, horizonDates);
const { canSubmit } = canSubmitForecast(id, currentGroundTruth);
setAlreadySubmitted(!canSubmit);
setPreviousGame(previousGame);
      } catch (err) {
        console.error('Error loading data:', err);
        setError(err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [playDate]);

  const latestObservationValue = useMemo(() => {
    const series = scenario?.groundTruthSeries;
    if (!series || series.length === 0) return 0;
    const lastValue = series[series.length - 1]?.value;
    return Number.isFinite(lastValue) ? lastValue : 0;
  }, [scenario?.groundTruthSeries]);

  useEffect(() => {
    if (!scenario) return;
    const initialInputs = initialiseForecastInputs(scenario?.horizons || [], latestObservationValue);
    setForecastEntries(initialInputs);
  }, [scenario, latestObservationValue]);

  const handleSubmit = () => {
    if (!forecastEntries || forecastEntries.length === 0) {
      console.error('No forecast entries to submit');
      return;
    }

    const hasInvalidEntries = forecastEntries.some(entry =>
      !entry || entry.median === null || entry.median === undefined || !Number.isFinite(entry.median)
    );

    if (hasInvalidEntries) {
      console.error('Some forecast entries have invalid median values');
      setSubmissionErrors({ general: 'Invalid forecast data. Please reset and try again.' });
      return;
    }

    const intervalsForValidation = convertToIntervals(forecastEntries);
    const { valid, errors } = validateForecastSubmission(intervalsForValidation);
    setSubmissionErrors(errors);

    if (!valid) {
      setSubmittedPayload(null);
      return;
    }

    const payload = intervalsForValidation.map(({ horizon, interval80 }) => ({
      horizon,
      interval80: [interval80.lower, interval80.upper],
    }));

    setSubmittedPayload({ submittedAt: new Date().toISOString(), payload });
    setInputMode('thankYou');

    try {
  const horizonDates = scenario.horizons.map((horizon) => addWeeksToDate(scenario.forecastDate, horizon));
  const id = buildGameId({
    challengeDate: scenario.challengeDate,
    forecastDate: scenario.forecastDate,
    dataset: scenario.dataset.key,
    location: scenario.location.name,
    target: scenario.dataset.targetKey,
  });
  saveForecastleGame({
    challengeDate: scenario.challengeDate,
    forecastDate: scenario.forecastDate,
    dataset: scenario.dataset.key,
    location: scenario.location.name,
    target: scenario.dataset.targetKey,
    userForecasts: forecastEntries,
    groundTruth: extractGroundTruthForHorizons(
      scenario.fullGroundTruthSeries,
      horizonDates
    ),
    horizonDates,
  });
  setSaveError(null);
  setPreviousGame(getForecastleGame(id));
  setAlreadySubmitted(true);
  setIsEditing(false);
} catch (error) {
      console.error('Failed to save game:', error);
      setSaveError(error.message || 'Failed to save game to storage');
    }
  };

  const handleEditForecast = () => {
  if (previousGame && previousGame.userForecasts) {
    setForecastEntries(previousGame.userForecasts.map((f) => ({
      horizon: f.horizon,
      median: f.median,
      lower80: f.lower80,
      upper80: f.upper80,
      width80: f.width80,
    })));
  }
  setIsEditing(true);
  setInputMode('median');
  setSubmittedPayload(null);
  setSubmissionErrors({});
  setSaveError(null);
};

  const handleResetMedians = () => {
    if (!scenario) return;
    const initialInputs = initialiseForecastInputs(scenario?.horizons || [], latestObservationValue);
    setForecastEntries(initialInputs);
    setSubmissionErrors({});
  };

  const handleResetIntervals = () => {
    const resetEntries = forecastEntries.map(entry => {
      const median = entry.median;
      const width80 = median * FORECASTLE_CONFIG.defaultIntervals.width80Percent;
      return {
        ...entry,
        lower80: Math.max(0, median - width80),
        upper80: median + width80,
        width80,
      };
    });
    setForecastEntries(resetEntries);
    setSubmissionErrors({});
  };

  const renderContent = () => {
    if (loading) {
      return (
        <Center style={{ minHeight: '60vh' }}>
          <Loader size="lg" />
        </Center>
      );
    }

    if (error) {
      return (
        <Alert icon={<IconAlertTriangle size={16} />} title="Unable to load Forecastle" color="red">
          {error.message}
        </Alert>
      );
    }

    if (!scenario) {
      return (
        <Alert icon={<IconAlertTriangle size={16} />} title="No challenge available" color="yellow">
          Please check back later for the next Forecastle challenge.
        </Alert>
      );
    }

    // Debug info - remove in production
    console.log('Rendering chart with:', {
      groundTruthSeriesLength: scenario.groundTruthSeries.length,
      previousSeasonSeriesLength: scenario.previousSeasonSeries.length,
      horizonDates: scenario.horizons.map(h => addWeeksToDate(scenario.forecastDate, h)),
    });

    const latestValue = Number.isFinite(latestObservationValue) ? latestObservationValue : 0;
    const baseMax = latestValue > 0 ? latestValue * 2 : 1;
    const userMaxCandidate = Math.max(
      ...forecastEntries.map((entry) => (entry.median ?? 0) + (entry.width80 ?? 0)),
      0,
    );
    const yAxisMax = Math.max(baseMax, userMaxCandidate * 1.1 || 0, latestObservationValue, 1);
    const horizonDates = scenario.horizons.map((horizon) => addWeeksToDate(scenario.forecastDate, horizon));

    const handleMedianAdjust = (index, field, value) => {
      setForecastEntries((prevEntries) =>
        prevEntries.map((entry, idx) => {
          if (idx !== index) return entry;
          const nextEntry = { ...entry };
          if (field === 'median') {
            const oldMedian = entry.median;
            const newMedian = Math.max(0, value);
            const medianShift = newMedian - oldMedian;
            nextEntry.median = newMedian;
            if (entry.lower80 !== undefined && entry.upper80 !== undefined) {
              nextEntry.lower80 = Math.max(0, entry.lower80 + medianShift);
              nextEntry.upper80 = entry.upper80 + medianShift;
            }
          } else if (field === 'interval80') {
            const [lower, upper] = value;
            nextEntry.lower80 = Math.max(0, lower);
            nextEntry.upper80 = Math.max(lower, upper);
            nextEntry.width80 = Math.max(nextEntry.upper80 - entry.median, entry.median - nextEntry.lower80);
          } else {
            nextEntry[field] = Math.max(0, value);
          }
          return nextEntry;
        }),
      );
      setSubmissionErrors({});
      if (submittedPayload) {
        setSubmittedPayload(null);
      }
    };

    return (
      <Stack gap="lg">
        <Paper shadow="sm" p="lg" radius="md" withBorder>
          <Stack gap="md">
            <Group justify="space-between" wrap="wrap" align="center">
              <Group gap="sm">
                <div>
                  <Title order={2}>Weekly Incidence Forecast</Title>
                  <Text size="sm" c="dimmed" fw={500}>
                    📅 {getWeekDateRange(scenario.challengeDate)}
                  </Text>
                </div>
              </Group>
            </Group>

            <Box>
              <Text size="sm" c="dimmed" mb="xs">
                We can display a custom text here!
              </Text>
              <Group gap="xs" wrap="wrap">
                <Text size="sm" fw={400}>
                  Predict
                </Text>
                <Badge size="md" variant="filled" color="blue" radius="sm">
                  {scenario?.dataset?.label || 'hospitalization'}
                </Badge>
                <Text size="sm" fw={400}>
                  in
                </Text>
                <Badge size="md" variant="filled" color="grape" radius="sm">
                  {scenario?.location?.name}
                </Badge>
                <Text size="sm" fw={400}>
                  at
                </Text>
                <Badge size="md" variant="filled" color="teal" radius="sm">
                  {scenario?.forecastDate}
                </Badge>
              </Group>
            </Box>

            <Divider />

            <Group justify="space-between" align="center" wrap="wrap">
              <Stepper
                active={inputMode === 'median' ? 0 : 1}
                onStepClick={(step) => {
                  if (step === 0) setInputMode('median');
                  else if (step === 1) setInputMode('intervals');
                }}
                allowNextStepsSelect={false}
                size="sm"
                style={{ flex: 1 }}
              >
                <Stepper.Step
                  label="Median"
                  description="Point forecasts"
                  completedIcon={<IconCheck size={16} />}
                />
                <Stepper.Step
                  label="80% Interval"
                  description="Uncertainty"
                  completedIcon={<IconCheck size={16} />}
                />
              </Stepper>
            </Group>

            {inputMode === 'thankYou' && (
  <Stack gap="lg" align="center" style={{ textAlign: 'center', padding: '2rem' }}>
    <Title order={3}>Thank You for Your Participation! 🎉</Title>
    <Text size="lg" c="dimmed">
      Your forecast has been submitted.
    </Text>
    <Button onClick={handleEditForecast} variant="outline" color="blue" size="md">
      Edit Your Forecast
    </Button>
  </Stack>
)}

	    {alreadySubmitted && inputMode !== 'thankYou' && !isEditing && (
  <Stack gap="lg" align="center" style={{ textAlign: 'center', padding: '2rem' }}>
    <Title order={3}>You've already forecasted this one</Title>
    <Text size="sm" c="dimmed">
      The underlying data hasn't changed since your last submission. You can still edit your forecast below.
    </Text>
    <Button onClick={handleEditForecast} variant="outline" color="blue" size="md">
      Edit Your Forecast
    </Button>
  </Stack>
)}

	    {inputMode !== 'thankYou' && (!alreadySubmitted || isEditing) && (
            inputMode === 'intervals' ? (
              <Grid gutter="lg">
                <Grid.Col span={{ base: 12, lg: 7 }}>
                  <Stack gap="md">
                    <Group justify="space-between">
                      <Title order={5}>Interactive Chart</Title>
                      <Switch
                        label="Show More History"
                        checked={!zoomedView}
                        onChange={(event) => setZoomedView(!event.currentTarget.checked)}
                        color="red"
                        size="md"
                      />
                    </Group>
                    <Box style={{ width: '100%', height: 380 }}>
                      <ForecastleChartCanvas
                        groundTruthSeries={scenario.groundTruthSeries}
                        previousSeasonSeries={scenario.previousSeasonSeries}
                        horizonDates={horizonDates}
                        entries={forecastEntries}
                        maxValue={yAxisMax}
                        onAdjust={handleMedianAdjust}
                        height={380}
                        showIntervals={true}
                        zoomedView={zoomedView}
                      />
                    </Box>
                    <Text size="sm" c="dimmed">
                      Drag the handles to adjust interval bounds, or use the sliders for precise control.
                    </Text>
                  </Stack>
                </Grid.Col>
                <Grid.Col span={{ base: 12, lg: 5 }}>
                  <Stack gap="md" h="100%">
                    <Title order={5}>Uncertainty Intervals</Title>
                    <ForecastleInputControls
                      entries={forecastEntries}
                      onChange={setForecastEntries}
                      maxValue={yAxisMax}
                      mode="intervals"
                      horizonDates={horizonDates}
                    />
                    <Box mt="auto">
                      <Stack gap="sm">
                        <Button
                          onClick={handleResetIntervals}
                          variant="light"
                          size="sm"
                          fullWidth
                          color="gray"
                          leftSection={<IconRefresh size={16} />}
                        >
                          Reset to Default
                        </Button>
                        <Button
                          onClick={() => {
                            handleSubmit();
                            setInputMode('thankYou');
                          }}
                          size="md"
                          fullWidth
                          disabled={inputMode === 'scoring'}
                        >
                          Submit & Thank You
                        </Button>
                      </Stack>
                    </Box>
                  </Stack>
                </Grid.Col>
              </Grid>
            ) : (
              <Grid gutter="lg">
                <Grid.Col span={{ base: 12, lg: 7 }}>
                  <Stack gap="md">
                    <Group justify="space-between">
                      <Title order={5}>Interactive Chart</Title>
                      <Switch
                        label="Show More History"
                        checked={!zoomedView}
                        onChange={(event) => setZoomedView(!event.currentTarget.checked)}
                        color="red"
                        size="md"
                      />
                    </Group>
                    <Box style={{ width: '100%', height: 380 }}>
                      <ForecastleChartCanvas
                        groundTruthSeries={scenario.groundTruthSeries}
                        previousSeasonSeries={scenario.previousSeasonSeries}
                        horizonDates={horizonDates}
                        entries={forecastEntries}
                        maxValue={yAxisMax}
                        onAdjust={handleMedianAdjust}
                        height={380}
                        showIntervals={false}
                        zoomedView={zoomedView}
                      />
                    </Box>
                    <Text size="sm" c="dimmed">
                      Drag the handles to set your median forecast for each week ahead.
                    </Text>
                  </Stack>
                </Grid.Col>
                <Grid.Col span={{ base: 12, lg: 5 }}>
                  <Stack gap="md" h="100%">
                    <Title order={5}>Median Forecasts</Title>
                    <ForecastleInputControls
                      entries={forecastEntries}
                      onChange={setForecastEntries}
                      maxValue={yAxisMax}
                      mode="median"
                      horizonDates={horizonDates}
                    />
                    <Box mt="auto">
                      <Stack gap="sm">
                        <Button
                          onClick={handleResetMedians}
                          variant="light"
                          size="sm"
                          fullWidth
                          color="gray"
                          leftSection={<IconRefresh size={16} />}
                        >
                          Reset to Default
                        </Button>
                        <Button
                          onClick={() => setInputMode('intervals')}
                          size="md"
                          fullWidth
                          rightSection="→"
                        >
                          Next: Set 80% Interval
                        </Button>
                      </Stack>
                    </Box>
                  </Stack>
                </Grid.Col>
              </Grid>
	      )
            )}
          </Stack>
        </Paper>
      </Stack>
    );
  };

  return (
    <>
      <Helmet>
        <title>RespiLens | Forecastle</title>
      </Helmet>
      <Container size="xl" py="xl" style={{ maxWidth: '1100px' }}>
        {renderContent()}
      </Container>
    </>
  );
};

export default ForecastleGame;