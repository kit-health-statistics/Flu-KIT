#!/usr/bin/env Rscript
# process_data.R
# Reads the GrippeWeb TSV (RKI) and writes the JSON the Flu@KIT app expects.
# Usage: Rscript process_data.R [input.tsv] [output.json]

suppressPackageStartupMessages(library(jsonlite))

# ---- Config ------------------------------------------------------------------
args <- commandArgs(trailingOnly = TRUE)
INPUT_FILE  <- if (length(args) >= 1) args[1] else "app/public/raw_data/GrippeWeb_Daten_des_Wochenberichts.tsv"
OUTPUT_FILE <- if (length(args) >= 2) args[2] else "app/public/processed_data/your-data.json"

FILTER_DISEASE <- "ARE"
FILTER_AGE     <- "00+"
FILTER_REGION  <- "Sueden"

LOCATION_NAME <- "Southern Germany"
DATASET_NAME  <- "GrippeWeb ARE"
N_SEASONS     <- 4   # the app uses the last season as current, the one before as previous

REQUIRED_COLS <- c("Saison", "Erkrankung", "Altersgruppe", "Region", "Kalenderwoche", "Inzidenz")

# ---- Read --------------------------------------------------------------------
raw <- read.delim(INPUT_FILE, sep = "\t", header = TRUE, stringsAsFactors = FALSE,
                  check.names = FALSE, fileEncoding = "UTF-8", na.strings = c("", "NA"))

missing <- setdiff(REQUIRED_COLS, names(raw))
if (length(missing) > 0) {
  stop("Missing column(s): ", paste(missing, collapse = ", "),
       "\nAvailable columns: ", paste(names(raw), collapse = ", "))
}

# ---- Filter ------------------------------------------------------------------
keep <- trimws(raw$Erkrankung) == FILTER_DISEASE &
  trimws(raw$Altersgruppe) == FILTER_AGE &
  trimws(raw$Region) == FILTER_REGION
df <- raw[keep, ]
if (nrow(df) == 0) {
  stop("No rows for ", FILTER_DISEASE, " / ", FILTER_AGE, " / ", FILTER_REGION,
       ".\nRegions in file: ", paste(unique(raw$Region), collapse = ", "))
}

df$week   <- trimws(df$Kalenderwoche)
df$season <- trimws(df$Saison)
df$value  <- as.numeric(gsub(",", ".", as.character(df$Inzidenz)))
df <- df[grepl("^\\d{4}-W\\d{2}$", df$week) & !is.na(df$value), ]
df <- df[order(df$week), ]   # "YYYY-Wxx" sorts chronologically as a string

if (anyDuplicated(df$week)) stop("Duplicate weeks after filtering - filters not specific enough.")

# ---- Keep the last N seasons -------------------------------------------------
keep_seasons <- tail(unique(df$season), N_SEASONS)
df <- df[df$season %in% keep_seasons, ]

# ---- Build JSON --------------------------------------------------------------
# I() keeps length-1 vectors as JSON arrays
out <- list(
  metadata = list(
    location      = I(LOCATION_NAME),
    location_name = I(LOCATION_NAME),
    dataset       = I(DATASET_NAME),
    series_type   = I("projection"),
    hubverse_keys = list(
      targets     = I("wk_inc"),
      horizon     = I(c("0", "1", "2")),
      output_type = I(character(0))
    )
  ),
  ground_truth = list(
    dates  = I(df$week),
    season = I(df$season),
    wk_inc = I(round(df$value))
  )
)

dir.create(dirname(OUTPUT_FILE), recursive = TRUE, showWarnings = FALSE)
write(toJSON(out, auto_unbox = TRUE, pretty = TRUE, digits = NA), OUTPUT_FILE)

message("Wrote ", nrow(df), " weeks (", df$week[1], " to ", df$week[nrow(df)],
        "; seasons: ", paste(keep_seasons, collapse = ", "), ") to ", OUTPUT_FILE)