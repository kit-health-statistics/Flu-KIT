export const validateForecastEntry = (entry) => {
  const issues = [];
  if (!entry) {
    return ['Missing forecast entry'];
  }
  const { interval80 } = entry;
  if (!interval80) {
    issues.push('Missing 80% interval');
    return issues;
  }
  const lower80 = Number(interval80.lower);
  const upper80 = Number(interval80.upper);
  const ensureFinite = (value, label) => {
    if (!Number.isFinite(value)) {
      issues.push(`${label} must be a finite number`);
      return false;
    }
    if (value < 0) {
      issues.push(`${label} must be non-negative`);
      return false;
    }
    return true;
  };
  const is80Valid = ensureFinite(lower80, '80% lower') && ensureFinite(upper80, '80% upper');
  if (is80Valid && lower80 > upper80) {
    issues.push('80% upper bound must be at least as large as the lower bound');
  }
  return issues;
};

export const validateForecastSubmission = (entries) => {
  const errors = {};
  let hasError = false;
  entries.forEach((entry) => {
    const entryIssues = validateForecastEntry(entry);
    if (entryIssues.length > 0) {
      hasError = true;
      errors[entry.horizon] = entryIssues;
    }
  });
  return {
    valid: !hasError,
    errors,
  };
};