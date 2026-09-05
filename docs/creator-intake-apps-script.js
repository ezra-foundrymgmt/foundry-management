/**
 * Foundry MGMT Model Information Sheet -> CreatorOS
 *
 * Paste this into the FORM's Apps Script project (form -> Extensions -> Apps
 * Script), then add an installable trigger: onFormSubmit, "From form",
 * "On form submit". See docs/CREATOR_INTAKE_SETUP.md.
 *
 * Form-bound, not spreadsheet-bound, on purpose. The form event gives each
 * answer's numeric item id, which survives re-wording a question. The
 * spreadsheet event gives `namedValues` keyed by question TITLE, so fixing a
 * typo in a question would silently break every field mapping downstream.
 */

var ENDPOINT = "https://creatoros-fm-staging.vercel.app/api/intake/google-form";
var SECRET_PROPERTY = "FOUNDRY_INTAKE_SECRET";
var SIGNATURE_VERSION = "v1";

function onFormSubmit(e) {
  var secret = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY);
  if (!secret) {
    // Loudly, not silently: a missing secret means every submission from here
    // on is being dropped, and the operator needs to know on the first one.
    throw new Error(
      "Script property " + SECRET_PROPERTY + " is not set. Submissions are not reaching CreatorOS.",
    );
  }

  var response = e.response;
  var answers = [];
  var itemResponses = response.getItemResponses();

  for (var i = 0; i < itemResponses.length; i++) {
    var itemResponse = itemResponses[i];
    var item = itemResponse.getItem();
    var raw = itemResponse.getResponse();

    // Checkbox and grid items answer with an array; everything else with a
    // string. Normalising to an array here means the server never has to guess
    // whether a comma inside an answer was a separator or part of her words.
    var values;
    if (raw === null || raw === undefined) values = [];
    else if (Object.prototype.toString.call(raw) === "[object Array]") values = flatten(raw);
    else values = [String(raw)];

    answers.push({
      itemId: item.getId(),
      title: item.getTitle(),
      values: values,
    });
  }

  var payload = {
    formId: extractFormId(FormApp.getActiveForm().getPublishedUrl()),
    responseId: response.getId(),
    submittedAt: response.getTimestamp().toISOString(),
    // Present only when the form collects email. Never trusted as identity by
    // the server -- it is context for whoever reviews the submission.
    respondentEmail: safeRespondentEmail(response),
    answers: answers,
  };

  postSigned(payload, secret);
}

function flatten(values) {
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var value = values[i];
    if (Object.prototype.toString.call(value) === "[object Array]") {
      for (var j = 0; j < value.length; j++) out.push(String(value[j]));
    } else if (value !== null && value !== undefined) {
      out.push(String(value));
    }
  }
  return out;
}

function safeRespondentEmail(response) {
  try {
    var email = response.getRespondentEmail();
    return email ? email : null;
  } catch (error) {
    // Throws when the form does not collect email. Not an error condition.
    return null;
  }
}

/**
 * The form id CreatorOS matches against organizations.settings_json.intakeFormId.
 * Published URLs look like .../forms/d/e/<ID>/viewform.
 */
function extractFormId(publishedUrl) {
  var match = /\/forms\/d\/e\/([^/]+)\//.exec(publishedUrl);
  return match ? match[1] : publishedUrl;
}

function postSigned(payload, secret) {
  var body = JSON.stringify(payload);
  var timestamp = String(Math.floor(Date.now() / 1000));
  var signature = SIGNATURE_VERSION + "=" + hmacHex(SIGNATURE_VERSION + ":" + timestamp + ":" + body, secret);

  var result = UrlFetchApp.fetch(ENDPOINT, {
    method: "post",
    contentType: "application/json",
    payload: body,
    headers: {
      "x-foundry-signature": signature,
      "x-foundry-timestamp": timestamp,
    },
    // So a non-2xx is inspectable here rather than an opaque exception.
    muteHttpExceptions: true,
  });

  var code = result.getResponseCode();
  if (code < 200 || code >= 300) {
    // Throwing puts the failure in Executions and emails the form owner. The
    // response itself is never lost -- it is still in the form's responses, and
    // re-saving it re-fires this trigger.
    throw new Error("CreatorOS rejected the submission: " + code + " " + result.getContentText());
  }
  console.log("CreatorOS accepted submission: " + result.getContentText());
}

/** HMAC-SHA256 as lowercase hex, matching apps/web/src/lib/intake-signature.ts. */
function hmacHex(value, secret) {
  var bytes = Utilities.computeHmacSha256Signature(value, secret);
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    // Apps Script bytes are signed (-128..127); mask before converting or every
    // byte above 0x7F produces a negative and the signature never matches.
    var byte = bytes[i] & 0xff;
    hex += (byte < 16 ? "0" : "") + byte.toString(16);
  }
  return hex;
}
