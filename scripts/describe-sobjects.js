'use strict';

/**
 * describe-sobjects.js
 *
 * Queries all SObjects in a Salesforce org and outputs a JSON mapping of
 * Label → API Name, plus metadata about each object (custom, customSetting,
 * keyPrefix, etc.).
 *
 * Three strategies are available (set via SF_STRATEGY env var):
 *
 *   "rest"     – (default) GET /sobjects/ — Describe Global.
 *                Fastest. Returns label, name, custom boolean directly.
 *                No pagination needed; single request.
 *
 *   "tooling"  – SOQL on EntityDefinition via Tooling API.
 *                Returns more fields (NamespacePrefix, PublisherId).
 *                Handles pagination automatically (2000-record batches).
 *
 *   "both"     – Runs REST first, then enriches with Tooling API data.
 *
 * Authentication
 * ──────────────
 * Uses the same OAuth2 Client Credentials flow as retriever/script.js.
 *
 * Environment variables
 * ─────────────────────
 * Required:
 *   SF_LOGIN_URL      – My Domain URL (e.g. https://mycompany.my.salesforce.com)
 *   SF_CLIENT_ID      – Connected App consumer key
 *   SF_CLIENT_SECRET   – Connected App consumer secret
 *
 * Optional:
 *   SF_API_VERSION    – API version (default: 62.0)
 *   SF_STRATEGY       – "rest" | "tooling" | "both" (default: rest)
 *   SF_OUTPUT_FILE    – Output path (default: sobjects.json)
 *   SF_QUERY_TIMEOUT  – Tooling API query timeout in ms (default: 120000)
 *
 * Usage
 * ─────
 *   SF_LOGIN_URL=https://mycompany.my.salesforce.com \
 *     SF_CLIENT_ID=3MVG9... SF_CLIENT_SECRET=... \
 *     node describe-sobjects.js
 */

const jsforce = require('jsforce');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function loadConfig() {
  const required = ['SF_LOGIN_URL', 'SF_CLIENT_ID', 'SF_CLIENT_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return Object.freeze({
    loginUrl:      process.env.SF_LOGIN_URL,
    clientId:      process.env.SF_CLIENT_ID,
    clientSecret:  process.env.SF_CLIENT_SECRET,
    apiVersion:    process.env.SF_API_VERSION || '62.0',
    strategy:      process.env.SF_STRATEGY || 'rest',
    outputFile:    process.env.SF_OUTPUT_FILE || 'sobjects.json',
    queryTimeout:  Number(process.env.SF_QUERY_TIMEOUT) || 120000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth (same as retriever)
// ─────────────────────────────────────────────────────────────────────────────

function authenticate(loginUrl, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();

    const url = new URL('/services/oauth2/token', loginUrl);

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {
          return reject(new Error(`OAuth response not JSON (HTTP ${res.statusCode}): ${text}`));
        }
        if (res.statusCode !== 200 || json.error) {
          return reject(new Error(`OAuth error: ${json.error || res.statusCode} – ${json.error_description || text}`));
        }
        resolve({ accessToken: json.access_token, instanceUrl: json.instance_url });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 1: REST Describe Global
// ─────────────────────────────────────────────────────────────────────────────
// Single GET request. No pagination. Returns the `custom` boolean directly.
// Limit: none — this endpoint always returns all SObjects.

async function describeGlobal(conn) {
  process.stderr.write('Fetching SObjects via REST Describe Global ...\n');
  const result = await conn.describeGlobal();
  process.stderr.write(`  Retrieved ${result.sobjects.length} SObjects.\n`);

  return result.sobjects.map(s => ({
    apiName:        s.name,
    label:          s.label,
    labelPlural:    s.labelPlural,
    custom:         s.custom,
    customSetting:  s.customSetting,
    keyPrefix:      s.keyPrefix || null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 2: Tooling API — EntityDefinition SOQL
// ─────────────────────────────────────────────────────────────────────────────
// Paginated automatically via queryMore. Batch size capped at 2000 by SF.
// PublisherId reveals origin: "System" vs org-id vs namespace.

async function queryEntityDefinitions(conn, timeoutMs) {
  process.stderr.write('Querying EntityDefinition via Tooling API ...\n');

  const soql = [
    'SELECT QualifiedApiName, Label, PluralLabel,',
    '       IsCustomSetting, KeyPrefix, NamespacePrefix, PublisherId',
    'FROM   EntityDefinition',
    'ORDER BY QualifiedApiName',
  ].join(' ');

  const records = [];
  let result = await conn.tooling.query(soql);
  records.push(...result.records);
  process.stderr.write(`  Batch 1: ${result.records.length} records\n`);

  let batch = 2;
  const deadline = Date.now() + timeoutMs;

  while (!result.done) {
    if (Date.now() > deadline) {
      throw new Error(`Tooling API query timed out after ${timeoutMs}ms (${records.length} records so far)`);
    }
    result = await conn.tooling.queryMore(result.nextRecordsUrl);
    records.push(...result.records);
    process.stderr.write(`  Batch ${batch++}: ${result.records.length} records (total: ${records.length})\n`);
  }

  process.stderr.write(`  Total: ${records.length} EntityDefinitions.\n`);

  return records.map(r => ({
    apiName:          r.QualifiedApiName,
    label:            r.Label,
    labelPlural:      r.PluralLabel || null,
    custom:           r.QualifiedApiName.endsWith('__c') || r.QualifiedApiName.endsWith('__mdt') || r.QualifiedApiName.endsWith('__e'),
    customSetting:    r.IsCustomSetting || false,
    keyPrefix:        r.KeyPrefix || null,
    namespacePrefix:  r.NamespacePrefix || null,
    publisherId:      r.PublisherId || null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 3: Both — REST base enriched with Tooling data
// ─────────────────────────────────────────────────────────────────────────────

async function describeBoth(conn, timeoutMs) {
  const [restData, toolingData] = await Promise.all([
    describeGlobal(conn),
    queryEntityDefinitions(conn, timeoutMs),
  ]);

  const toolingMap = new Map(toolingData.map(t => [t.apiName, t]));

  return restData.map(r => {
    const t = toolingMap.get(r.apiName);
    return {
      ...r,
      namespacePrefix: t?.namespacePrefix || null,
      publisherId:     t?.publisherId || null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Output formatting
// ─────────────────────────────────────────────────────────────────────────────

function buildOutput(objects) {
  // Sort by label for readability
  objects.sort((a, b) => a.label.localeCompare(b.label));

  // Flat lookup: label → apiName
  const labelToApi = {};
  const apiToLabel = {};
  for (const obj of objects) {
    labelToApi[obj.label] = obj.apiName;
    apiToLabel[obj.apiName] = obj.label;
  }

  return {
    _metadata: {
      description: 'Salesforce SObject label/API name mappings. Generated via REST Describe Global and/or Tooling API EntityDefinition query.',
      totalObjects: objects.length,
      generatedAt: new Date().toISOString(),
    },
    labelToApiName: labelToApi,
    apiNameToLabel: apiToLabel,
    objects: objects,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();

  // Authenticate
  process.stderr.write(`Authenticating to ${config.loginUrl} ...\n`);
  const { accessToken, instanceUrl } = await authenticate(
    config.loginUrl, config.clientId, config.clientSecret
  );
  process.stderr.write(`Connected. Instance: ${instanceUrl}\n\n`);

  const conn = new jsforce.Connection({
    instanceUrl,
    accessToken,
    version: config.apiVersion,
  });

  // Run selected strategy
  let objects;
  switch (config.strategy) {
    case 'rest':
      objects = await describeGlobal(conn);
      break;
    case 'tooling':
      objects = await queryEntityDefinitions(conn, config.queryTimeout);
      break;
    case 'both':
      objects = await describeBoth(conn, config.queryTimeout);
      break;
    default:
      throw new Error(`Unknown strategy: "${config.strategy}". Use "rest", "tooling", or "both".`);
  }

  // Build and write output
  const output = buildOutput(objects);
  const json = JSON.stringify(output, null, 2) + '\n';

  const outPath = path.resolve(config.outputFile);
  fs.writeFileSync(outPath, json, 'utf8');
  process.stderr.write(`\nWritten ${output._metadata.totalObjects} objects to ${outPath}\n`);

  // Summary to stderr
  const customCount = objects.filter(o => o.custom).length;
  const standardCount = objects.length - customCount;
  process.stderr.write(`  Standard: ${standardCount} | Custom: ${customCount}\n`);
}

main().catch(err => {
  process.stderr.write(`\nFATAL: ${err.message}\n`);
  if (err.stack) process.stderr.write(err.stack + '\n');
  process.exitCode = 1;
});
