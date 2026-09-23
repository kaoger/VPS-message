import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../config/questions.json", import.meta.url));
const CONFIG_PATH = process.env.QUESTIONS_PATH ? path.resolve(process.env.QUESTIONS_PATH) : DEFAULT_CONFIG_PATH;
const validators = {
  tw_mobile_09: (raw) => /^09\d{8}$/.test(String(raw || "").trim()),
};

function configError(message) {
  return new Error(`Invalid questions config at ${CONFIG_PATH}: ${message}`);
}

function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    throw configError(`unable to read file (${error.message})`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw configError(`invalid JSON (${error.message})`);
  }

  if (!config || typeof config !== "object") throw configError("root must be an object");
  if (!Array.isArray(config.flow) || config.flow.length < 1) {
    throw configError("flow must contain at least 1 question");
  }
  if (!config.confirm || typeof config.confirm !== "object") throw configError("confirm must be an object");

  const keys = new Set();
  const flow = config.flow.map((step, index) => {
    const label = `flow[${index}]`;
    if (!step || typeof step !== "object") throw configError(`${label} must be an object`);
    if (typeof step.key !== "string" || !step.key) throw configError(`${label}.key is required`);
    if (keys.has(step.key)) throw configError(`duplicate flow key: ${step.key}`);
    keys.add(step.key);
    if (!["quick_reply", "button_template", "text"].includes(step.type)) throw configError(`${label}.type is invalid`);
    if (typeof step.text !== "string" || !step.text) throw configError(`${label}.text is required`);

    const normalized = { ...step };
    if (step.type === "quick_reply" || step.type === "button_template") {
      if (!Array.isArray(step.options) || step.options.length === 0) {
        throw configError(`${label}.options must be a non-empty array`);
      }
      normalized.options = step.options.map((option, optionIndex) => {
        if (!option || typeof option.title !== "string" || typeof option.payload !== "string") {
          throw configError(`${label}.options[${optionIndex}] requires title and payload`);
        }
        return [option.title, option.payload];
      });
      if (step.other != null) {
        if (typeof step.other.payload !== "string" || typeof step.other.prompt !== "string") {
          throw configError(`${label}.other requires payload and prompt`);
        }
        normalized.otherPayload = step.other.payload;
        normalized.otherPrompt = step.other.prompt;
      }
    }
    if (step.validate != null) {
      if (!validators[step.validate]) throw configError(`${label}.validate is unknown: ${step.validate}`);
      normalized.validate = validators[step.validate];
    }
    if (step.error_text != null) normalized.errorText = step.error_text;
    return normalized;
  });

  const confirm = config.confirm;
  if (!Array.isArray(confirm.options) || confirm.options.length === 0) {
    throw configError("confirm.options must be a non-empty array");
  }
  const confirmOptions = confirm.options.map((option, index) => {
    if (!option || typeof option.title !== "string" || typeof option.payload !== "string") {
      throw configError(`confirm.options[${index}] requires title and payload`);
    }
    return [option.title, option.payload];
  });
  for (const field of ["success_text", "summary_footer"]) {
    if (typeof confirm[field] !== "string" || !confirm[field]) throw configError(`confirm.${field} is required`);
  }
  if (!confirm.summary_labels || typeof confirm.summary_labels !== "object") {
    throw configError("confirm.summary_labels must be an object");
  }
  for (const key of keys) {
    if (typeof confirm.summary_labels[key] !== "string") {
      throw configError(`confirm.summary_labels.${key} is required`);
    }
  }

  return { config, flow, confirmOptions };
}

const loaded = loadConfig();

export const FLOW = loaded.flow;
export const getFlow = () => FLOW;
export const SUMMARY_LABELS = Object.freeze({ ...loaded.config.confirm.summary_labels });
export const CONFIRM_OPTIONS = loaded.confirmOptions;
export const SUBMIT_SUCCESS_TEXT = loaded.config.confirm.success_text;
export const IS_TEST_BUILD = false;

export function buildSummary(answers) {
  const lines = ["以下是您填寫的資料：", ""];
  for (const step of FLOW) lines.push(`${SUMMARY_LABELS[step.key]}：${answers[step.key] ?? ""}`);
  lines.push("", loaded.config.confirm.summary_footer);
  return lines.join("\n");
}

export function titleForPayload(stepDef, payload) {
  if (!stepDef?.options) return null;
  const hit = stepDef.options.find(([, optionPayload]) => optionPayload === payload);
  return hit ? hit[0] : null;
}
