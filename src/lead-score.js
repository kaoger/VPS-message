import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORM_FIELDS } from "./form-schema.js";
import { logEvent } from "./log-event.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCORING_FIELDS = ["service", "area", "size", "timeline", "budget"];
const OPTIONS = new Map(FORM_FIELDS.filter(field => SCORING_FIELDS.includes(field.key))
  .map(field => [field.key, new Set(field.options)]));
const GRADES = new Set(["hot", "normal", "low"]);
const EMPTY_SCORE = { score: null, grade: null, reasons: null };

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isValidConfig(config) {
  if (!isObject(config) || !hasOnlyKeys(config, ["version", "fields", "grades"]) ||
      config.version !== 1 || !isObject(config.fields) || !Array.isArray(config.grades) ||
      !hasOnlyKeys(config.fields, SCORING_FIELDS)) return false;

  for (const [field, scores] of Object.entries(config.fields)) {
    if (!isObject(scores)) return false;
    for (const [option, points] of Object.entries(scores)) {
      if (!OPTIONS.get(field).has(option) || !Number.isInteger(points) || points < 0 || points > 100) return false;
    }
  }
  if (Object.values(config.fields).some(scores => Object.keys(scores).length > 0) &&
      config.grades.length === 0) return false;

  let previousMin = Infinity;
  const seenGrades = new Set();
  for (const item of config.grades) {
    if (!isObject(item) || !hasOnlyKeys(item, ["grade", "min", "label"]) ||
        !GRADES.has(item.grade) || seenGrades.has(item.grade) ||
        !Number.isInteger(item.min) || item.min < 0 || item.min > 500 || item.min >= previousMin ||
        typeof item.label !== "string" || !item.label.trim()) return false;
    seenGrades.add(item.grade);
    previousMin = item.min;
  }
  return config.grades.length === 0 || previousMin === 0;
}

/** Read and validate on every call so mounted rules can change without restarting. */
export function loadScoringConfig() {
  const configPath = path.resolve(PROJECT_ROOT, process.env.LEAD_SCORING_PATH || "config/lead-scoring.json");
  let contents;
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch {
    logEvent("lead_score_config_missing");
    return null;
  }
  try {
    const config = JSON.parse(contents);
    if (isValidConfig(config)) return config;
  } catch {
    // Invalid JSON is handled like any other invalid configuration.
  }
  logEvent("lead_score_config_invalid");
  return null;
}

/** Pure calculation; absent or invalid rules have no score. */
export function scoreLead(answers, config) {
  if (!isValidConfig(config) || config.grades.length === 0) return { ...EMPTY_SCORE };
  let score = 0;
  const reasons = [];
  for (const field of SCORING_FIELDS) {
    const option = answers?.[field];
    const points = Object.hasOwn(config.fields[field] ?? {}, option)
      ? config.fields[field][option] : 0;
    score += points;
    if (points > 0) reasons.push(`${option} +${points}`);
  }
  const grade = config.grades.find(item => score >= item.min)?.grade ?? null;
  return { score, grade, reasons };
}

/** Scoring is best effort; a scoring exception must never prevent a lead write. */
export function scoreLeadForStorage(answers) {
  try {
    return scoreLead(answers, loadScoringConfig());
  } catch {
    try { logEvent("lead_score_fail"); } catch { /* keep the lead write available */ }
    return { ...EMPTY_SCORE };
  }
}
