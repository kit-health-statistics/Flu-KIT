#!/usr/bin/env Rscript
# process_data.R
# Builds the JSON used by the Flu@KIT app: one entry per forecast round.
#   1. GrippeWeb ARE, Southern Germany                  (RKI GrippeWeb TSV)
#   2. ARE consultation incidence, Baden-Wuerttemberg   (RKI ARE-Konsultationsinzidenz TSV)
#   3. Seasonal influenza, Gebietseinheit Karlsruhe     (RKI SurvStat, package 'rsurvstat')
#
# Usage: Rscript process_data.R [input_dir] [output.json]
#   input_dir  contains the two TSV files; the SurvStat download is saved there as CSV.

suppressPackageStartupMessages(library(jsonlite))

# ---- Config -------------------------------------------------------------------
args <- commandArgs(trailingOnly = TRUE)
INPUT_DIR   <- if (length(args) >= 1) args[1] else "app/public/raw_data"
OUTPUT_FILE <- if (length(args) >= 2) args[2] else "app/public/processed_data/your-data.json"

N_SEASONS <- 4                    # current season + 3 past seasons
HORIZONS  <- c("0", "1", "2")

DATASETS <- list(
  list(
    key = "grippeweb_are_south",
    source = "tsv",
    file = "GrippeWeb_Daten_des_Wochenberichts.tsv",
    filters = list(Erkrankung = "ARE", Altersgruppe = "00+", Region = "Sueden"),
    col_week = "Kalenderwoche", col_season = "Saison", col_value = "Inzidenz",
    dataset_name = "GrippeWeb ARE",
    location_name = "Southern Germany"
  ),
  list(
    key = "are_consultation_bw",
    source = "tsv",
    file = "ARE-Konsultationsinzidenz.tsv",
    filters = list(Bundesland = "Baden-Wuerttemberg", Altersgruppe = "00+"),
    col_week = "Kalenderwoche", col_season = "Saison", col_value = "ARE_Konsultationsinzidenz",
    dataset_name = "ARE Consultation Incidence",
    location_name = "Baden-W\u00fcrttemberg"
  ),
  list(
    key = "survstat_influenza_karlsruhe",
    source = "survstat",
    disease = "Influenza, seasonal",   # name in rsurvstat::diseases
    measure = "Count",                 # "Count" or "Incidence"
    geography = "nuts",                # NUTS level of SurvStat (Regierungsbezirke etc.)
    # Region to keep: "Gebietseinheit Karlsruhe" (Baden-W\u00fcrttemberg, NUTS DE12)
    geo_code = "[DeutschlandNodes].[Kreise71Web].[FedStateKey71].&[08].&[DE12]",
    geo_name = "Gebietseinheit Karlsruhe",
    years_back = 5,                    # how many calendar years to download
    exclude_recent_weeks = 1,          # drop the current (incomplete) week plus this many-1 weeks before it; future weeks are always dropped
    raw_file = "SurvStat_Influenza_Karlsruhe.csv",
    dataset_name = "SurvStat Influenza",
    location_name = "Karlsruhe"
  )
)

# ---- Helpers ------------------------------------------------------------------
fail <- function(cfg, ...) stop("[", cfg$key, "] ", ..., call. = FALSE)

# Season runs from week 40 to week 39 of the next year: "2024/25"
season_from_iso <- function(iso_year, iso_week) {
  start <- ifelse(iso_week >= 40, iso_year, iso_year - 1)
  sprintf("%d/%02d", start, (start + 1) %% 100)
}

# ---- Source 1/2: RKI TSV files ---------------------------------------------------
build_from_tsv <- function(cfg) {
  path <- file.path(INPUT_DIR, cfg$file)
  if (!file.exists(path)) fail(cfg, "File not found: ", path)
  
  raw <- read.delim(path, sep = "\t", header = TRUE, stringsAsFactors = FALSE,
                    check.names = FALSE, fileEncoding = "UTF-8", na.strings = c("", "NA"))
  
  needed  <- c(names(cfg$filters), cfg$col_week, cfg$col_season, cfg$col_value)
  missing <- setdiff(needed, names(raw))
  if (length(missing) > 0) {
    fail(cfg, "Missing column(s): ", paste(missing, collapse = ", "),
         ". Available: ", paste(names(raw), collapse = ", "))
  }
  
  keep <- rep(TRUE, nrow(raw))
  for (col in names(cfg$filters)) {
    keep <- keep & ((trimws(raw[[col]]) == cfg$filters[[col]]) %in% TRUE)
  }
  df <- raw[keep, , drop = FALSE]
  if (nrow(df) == 0) fail(cfg, "No rows match the filters. Check the filter values.")
  
  data.frame(
    week   = trimws(df[[cfg$col_week]]),
    season = trimws(df[[cfg$col_season]]),
    value  = as.numeric(gsub(",", ".", as.character(df[[cfg$col_value]]))),
    stringsAsFactors = FALSE
  )
}

# ---- Source 3: SurvStat via rsurvstat -------------------------------------------
build_from_survstat <- function(cfg) {
  if (!requireNamespace("rsurvstat", quietly = TRUE)) fail(cfg, "Package 'rsurvstat' is not installed.")
  
  disease_key <- rsurvstat::diseases[[cfg$disease]]
  if (is.null(disease_key)) {
    similar <- grep("influenza", names(rsurvstat::diseases), ignore.case = TRUE, value = TRUE)
    fail(cfg, "Unknown SurvStat disease '", cfg$disease, "'. Names containing 'influenza': ",
         paste(similar, collapse = ", "))
  }
  
  this_year  <- as.integer(format(Sys.Date(), "%Y"))
  first_date <- as.Date(sprintf("%d-01-01", this_year - cfg$years_back))
  
  # Only pass the optional arguments that the installed version of rsurvstat knows
  fn_args <- names(formals(rsurvstat::get_timeseries))
  call_args <- list(disease_key, measure = cfg$measure, geography = cfg$geography)
  if ("years" %in% fn_args) call_args$years <- (this_year - cfg$years_back):this_year
  if (".progress" %in% fn_args) call_args$.progress <- FALSE
  
  ts <- as.data.frame(do.call(rsurvstat::get_timeseries, call_args))
  if (nrow(ts) == 0) fail(cfg, "SurvStat returned no rows.")
  if (!"date" %in% names(ts)) {
    fail(cfg, "Unexpected SurvStat result, no 'date' column. Columns: ", paste(names(ts), collapse = ", "))
  }
  
  # Keep only the wanted region (by code if available, otherwise by name)
  geo_col <- if (!is.null(cfg$geo_code) && "geo_code" %in% names(ts)) "geo_code" else "geo_name"
  geo_value <- cfg[[geo_col]]
  if (!geo_col %in% names(ts)) {
    fail(cfg, "Unexpected SurvStat result, no '", geo_col, "' column. Columns: ", paste(names(ts), collapse = ", "))
  }
  regions <- if ("geo_name" %in% names(ts)) unique(as.character(ts$geo_name)) else character(0)
  ts <- ts[(as.character(ts[[geo_col]]) == geo_value) %in% TRUE, , drop = FALSE]
  if (nrow(ts) == 0) {
    fail(cfg, "No rows for ", geo_col, " = '", geo_value, "'. Regions in the result: ",
         paste(regions, collapse = ", "))
  }
  if ("geo_name" %in% names(ts) && !all(ts$geo_name == cfg$geo_name)) {
    warning("[", cfg$key, "] geo_name in the data differs from '", cfg$geo_name, "': ",
            paste(unique(ts$geo_name), collapse = ", "))
  }
  
  # The value column: 'count' / 'incidence', or the only numeric column
  value_col <- tolower(cfg$measure)
  if (!value_col %in% names(ts)) {
    numeric_cols <- names(ts)[vapply(ts, is.numeric, logical(1))]
    if (length(numeric_cols) == 1) {
      value_col <- numeric_cols
    } else {
      fail(cfg, "Cannot find the value column. Columns: ", paste(names(ts), collapse = ", "))
    }
  }
  
  d <- as.Date(ts$date)
  
  # SurvStat also returns the weeks that have not happened yet (with 0 notifications).
  # Keep only complete weeks: everything before the current ISO week (minus a safety margin).
  monday <- function(x) x - (as.integer(format(x, "%u")) - 1)
  latest_week_start <- monday(Sys.Date()) - 7 * cfg$exclude_recent_weeks
  keep <- d >= first_date & monday(d) <= latest_week_start
  ts <- ts[keep, , drop = FALSE]
  d  <- d[keep]
  if (length(d) == 0) fail(cfg, "No SurvStat rows between ", format(first_date), " and ", format(latest_week_start), ".")
  
  # Keep the raw download (this region only) for reproducibility
  utils::write.csv(ts, file.path(INPUT_DIR, cfg$raw_file), row.names = FALSE)
  
  if (anyDuplicated(d)) fail(cfg, "Duplicate dates in the SurvStat result.")
  all_dates <- seq(min(d), max(d), by = "7 days")
  if (!all(as.character(d) %in% as.character(all_dates))) {
    fail(cfg, "SurvStat dates are not on a regular weekly grid.")
  }
  
  # Weeks missing from the result are weeks without notifications -> fill with 0
  values <- as.numeric(ts[[value_col]][match(as.character(all_dates), as.character(d))])
  message("[", cfg$key, "] filling ", sum(is.na(values)), " missing week(s) with 0")
  values[is.na(values)] <- 0
  
  iso_year <- as.integer(format(all_dates, "%G"))
  iso_week <- as.integer(format(all_dates, "%V"))
  data.frame(
    week   = sprintf("%d-W%02d", iso_year, iso_week),
    season = season_from_iso(iso_year, iso_week),
    value  = values,
    stringsAsFactors = FALSE
  )
}

# ---- Common: clean, keep the last seasons, build the JSON entry --------------------
finalize_dataset <- function(cfg, df) {
  df <- df[grepl("^\\d{4}-W\\d{2}$", df$week) & !is.na(df$value) & !is.na(df$season), ]
  if (nrow(df) == 0) fail(cfg, "No valid rows after cleaning.")
  df <- df[order(df$week), ]   # "YYYY-Wxx" sorts chronologically as a string
  if (anyDuplicated(df$week)) fail(cfg, "Duplicate weeks - filters are not specific enough.")
  
  keep_seasons <- tail(unique(df$season), N_SEASONS)
  df <- df[df$season %in% keep_seasons, ]
  message("[", cfg$key, "] ", nrow(df), " weeks, ", df$week[1], " to ", df$week[nrow(df)],
          "; seasons: ", paste(keep_seasons, collapse = ", "))
  
  # I() keeps length-1 vectors as JSON arrays
  list(
    metadata = list(
      key           = I(cfg$key),
      location      = I(cfg$location_name),
      location_name = I(cfg$location_name),
      dataset       = I(cfg$dataset_name),
      series_type   = I("projection"),
      hubverse_keys = list(
        targets     = I("wk_inc"),
        horizon     = I(HORIZONS),
        output_type = I(character(0))
      )
    ),
    ground_truth = list(
      dates  = I(df$week),
      season = I(df$season),
      wk_inc = I(round(df$value))
    )
  )
}

# ---- Main ---------------------------------------------------------------------
datasets <- lapply(DATASETS, function(cfg) {
  df <- switch(cfg$source,
               tsv      = build_from_tsv(cfg),
               survstat = build_from_survstat(cfg),
               fail(cfg, "Unknown source '", cfg$source, "'")
  )
  finalize_dataset(cfg, df)
})

dir.create(dirname(OUTPUT_FILE), recursive = TRUE, showWarnings = FALSE)
json <- toJSON(list(datasets = datasets), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(json, OUTPUT_FILE, useBytes = TRUE)
message("Wrote ", length(datasets), " dataset(s) to ", OUTPUT_FILE)