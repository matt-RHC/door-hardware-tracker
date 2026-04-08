#!/usr/bin/env node
/**
 * Golden PDF Test Suite Runner
 *
 * Runs all training PDFs through the full extraction pipeline API
 * (parse-pdf + LLM review) and collects metrics for Smartsheet logging.
 *
 * Usage:
 *   node scripts/run-golden-suite.mjs
 *
 * Requires: dev server running on localhost:3000 with service role bypass enabled
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { execSync } from 'child_process';
import { PDFDocument } from 'pdf-lib';

// ── Config ──
const BASE_URL = 'http://localhost:3000';
const CHUNK_SIZE_THRESHOLD = 3 * 1024 * 1024; // 3MB
const PAGES_PER_CHUNK = 35;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY env var is required. Set it before running.');
  process.exit(1);
}

// ── PDF Catalog (sorted by size ascending) ──
const PDF_DIR = resolve(import.meta.dirname, '..', 'test-pdfs', 'training');

const PDF_CATALOG = [
  { shortName: 'sched-Barnstable', filename: 'Barnstable Group - Hardware Spec + Submittal Information.pdf' },
  { shortName: 'sched-Kdot', filename: 'Kdot Group - Hardware Spec + Submittal Information.pdf' },
  { shortName: 'spec-8pg', filename: 'Unknown - Hardware Submittal (8pg).pdf' },
  { shortName: 'spec-19pg', filename: 'Unknown - Hardware Submittal (19pg).pdf' },
  { shortName: 'sched-Lutheran', filename: 'Lutheran Group - Hardware Spec + Submittal Information.pdf' },
  { shortName: 'sched-Cornell', filename: 'Cornell Group - Hardware Spec + Submittal Information.pdf' },
  { shortName: 'sched-Etica', filename: 'Etica Group - Hardware Spec + Submittal Information.pdf' },
  { shortName: 'sched-Claymont', filename: 'Claymont Group - Hardware Spec + Submittal Information.pdf' },
  { shortName: 'arch-717010A', filename: 'Unknown - 717010A Door Schedule (1pg Bluebeam).pdf' },
  { shortName: 'grid-MCA', filename: 'MCA Hardware.pdf' },
  { shortName: 'grid-RR', filename: '306169_RR_HW_Submittal_03-20-26.pdf' },
  { shortName: 'grid-RPL10', filename: 'Updated_Hardware_Submittal-_RPL10_NW_Data_Center_Rayville_LA_2.pdf' },
  { shortName: 'grid-MCN', filename: '081113-01-2  Door Frames + Hardware_MCN CD.pdf' },
  { shortName: 'sched-AKN', filename: 'AKN - Approved - Door Hardware.pdf' },
  { shortName: 'mixed-UCO', filename: 'UCO - Approved - Door Hardware.pdf' },
  { shortName: 'sched-DT', filename: 'DT Group - Hardware Spec + Submittal Information.pdf' },
  { shortName: 'grid-CAA', filename: 'Approved Hardware Submittal.pdf' },
  { shortName: 'kinship-GTN3', filename: '08 71 00-1.1_Door Hardware SD_BMcD Arch Response.pdf' },
];

// ── Previous baselines for regression detection ──
const BASELINES = {
  'grid-MCN': { doors: 6, sets: 6 },
  'grid-RR': { doors: 107, sets: null },
  'grid-MCA': { doors: 326, sets: null },
  'grid-RPL10': { doors: 130, sets: 31 },
  'grid-CAA': { doors: 78, sets: 25 },
  'sched-AKN': { doors: 180, sets: 3 },
  'sched-Barnstable': { doors: 0, sets: 3 },
  'sched-Claymont': { doors: 0, sets: 29 },
  'sched-Cornell': { doors: 4, sets: 22 },
  'sched-DT': { doors: 105, sets: 1 },
  'sched-Etica': { doors: 0, sets: 17 },
  'sched-Kdot': { doors: 0, sets: 0 },
  'sched-Lutheran': { doors: 0, sets: 26 },
  'mixed-UCO': { doors: 0, sets: 0 },
  'kinship-GTN3': { doors: 319, sets: 96 },
  'arch-717010A': { doors: 145, sets: 0 },
  'spec-19pg': { doors: 0, sets: 1 },
  'spec-8pg': { doors: 10, sets: 0 },
};

// ── Auth headers for service role bypass ──
const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  'x-service-role': SERVICE_ROLE_KEY,
};

// ── Convert buffer to base64 ──
function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

// ── Split PDF into chunks using pdf-lib ──
async function splitPDF(pdfBuffer, pagesPerChunk = PAGES_PER_CHUNK) {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const totalPages = srcDoc.getPageCount();
  const chunks = [];

  for (let start = 0; start < totalPages; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, totalPages);
    const chunkDoc = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const copiedPages = await chunkDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(page => chunkDoc.addPage(page));
    const chunkBytes = await chunkDoc.save();
    chunks.push({
      base64: bufferToBase64(chunkBytes),
      startPage: start,
      endPage: end,
      pageCount: end - start,
    });
  }

  console.log(`   Split into ${chunks.length} chunks (${pagesPerChunk} pages each)`);
  return chunks;
}

// ── POST to main parse-pdf endpoint ──
async function callParsePDF(pdfBase64) {
  const res = await fetch(`${BASE_URL}/api/parse-pdf?parseOnly=true`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ pdfBase64 }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`parse-pdf failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  return res.json();
}

// ── POST to chunk endpoint ──
async function callParseChunk(chunkBase64, chunkIndex, totalChunks, knownSetIds) {
  const res = await fetch(`${BASE_URL}/api/parse-pdf/chunk`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      chunkBase64,
      chunkIndex,
      totalChunks,
      knownSetIds,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`parse-pdf/chunk failed (${res.status}): ${errText.slice(0, 500)}`);
  }

  return res.json();
}

// ── Merge chunk results (simplified version of pdf-utils.ts logic) ──
function mergeResults(chunkResults) {
  const allDoors = [];
  const allSets = [];
  const seenDoorNumbers = new Set();
  const seenSetIds = new Set();

  for (const chunk of chunkResults) {
    // Merge doors (dedup by door_number)
    for (const door of (chunk.doors ?? [])) {
      const dn = door.door_number ?? door.doorNumber;
      if (dn && !seenDoorNumbers.has(dn)) {
        seenDoorNumbers.add(dn);
        allDoors.push(door);
      }
    }

    // Merge sets (dedup by set_id, merge items for duplicate sets)
    for (const set of (chunk.hardwareSets ?? chunk.sets ?? [])) {
      const sid = set.set_id ?? set.setId;
      if (sid && !seenSetIds.has(sid)) {
        seenSetIds.add(sid);
        allSets.push(set);
      } else if (sid && seenSetIds.has(sid)) {
        // Merge items into existing set
        const existing = allSets.find(s => (s.set_id ?? s.setId) === sid);
        if (existing) {
          const existingItems = existing.items ?? [];
          const newItems = set.items ?? [];
          existing.items = [...existingItems, ...newItems];
        }
      }
    }
  }

  return { doors: allDoors, sets: allSets };
}

// ── Count total hardware items across sets ──
function countItems(sets) {
  return sets.reduce((sum, s) => sum + (s.items?.length ?? 0), 0);
}

// ── Process a single PDF ──
async function processPDF(entry) {
  const filePath = resolve(PDF_DIR, entry.filename);
  const pdfBuffer = readFileSync(filePath);
  const fileSize = pdfBuffer.length;
  const isChunked = fileSize > CHUNK_SIZE_THRESHOLD;

  console.log(`\n📄 [${entry.shortName}] ${(fileSize / 1024).toFixed(0)}KB ${isChunked ? '(CHUNKED)' : ''}`);

  const startTime = Date.now();
  let doors = [], sets = [], flaggedDoors = [], error = null;
  let pageCount = 0;

  try {
    // Get page count
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pageCount = pdfDoc.getPageCount();
    console.log(`   ${pageCount} pages`);

    if (isChunked) {
      // Chunked flow
      const chunks = await splitPDF(pdfBuffer);
      const chunkResults = [];
      const knownSetIds = [];

      for (let i = 0; i < chunks.length; i++) {
        console.log(`   Chunk ${i + 1}/${chunks.length} (pages ${chunks[i].startPage + 1}-${chunks[i].endPage})...`);
        const result = await callParseChunk(
          chunks[i].base64, i, chunks.length, knownSetIds
        );
        chunkResults.push(result);

        // Collect known set IDs for next chunk
        for (const s of (result.hardwareSets ?? result.sets ?? [])) {
          const sid = s.set_id ?? s.setId;
          if (sid && !knownSetIds.includes(sid)) knownSetIds.push(sid);
        }

        console.log(`   Chunk ${i + 1}: ${(result.doors?.length ?? 0)} doors, ${(result.hardwareSets?.length ?? result.sets?.length ?? 0)} sets`);
      }

      const merged = mergeResults(chunkResults);
      doors = merged.doors;
      sets = merged.sets;
    } else {
      // Single request flow
      const pdfBase64 = bufferToBase64(pdfBuffer);
      console.log(`   Sending ${(pdfBase64.length / 1024).toFixed(0)}KB base64...`);
      const result = await callParsePDF(pdfBase64);

      doors = result.doors ?? [];
      sets = result.sets ?? [];
      flaggedDoors = result.flaggedDoors ?? [];
    }
  } catch (err) {
    error = err.message;
    console.error(`   ERROR: ${error}`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalItems = countItems(sets);

  console.log(`   Result: ${doors.length} doors, ${sets.length} sets, ${totalItems} items (${duration}s)`);
  if (flaggedDoors.length > 0) {
    console.log(`   Flagged: ${flaggedDoors.length} doors`);
  }

  return {
    shortName: entry.shortName,
    filename: entry.filename,
    pageCount,
    fileSize,
    doorCount: doors.length,
    setCount: sets.length,
    totalItems,
    flaggedCount: flaggedDoors.length,
    duration: parseFloat(duration),
    error,
    setIds: sets.map(s => s.set_id ?? s.setId).filter(Boolean),
  };
}

// ── Compare against baselines ──
function compareBaselines(results) {
  console.log('\n\n═══════════════════════════════════════════════');
  console.log('  REGRESSION CHECK vs S-066 Baselines');
  console.log('═══════════════════════════════════════════════\n');

  const regressions = [];
  const improvements = [];
  const stable = [];

  for (const r of results) {
    const bl = BASELINES[r.shortName];
    if (!bl) {
      console.log(`  ❓ ${r.shortName}: No baseline`);
      continue;
    }

    const notes = [];
    let status = 'STABLE';

    if (bl.doors !== null) {
      if (r.doorCount < bl.doors) {
        notes.push(`Doors DECREASED: ${bl.doors} → ${r.doorCount}`);
        status = 'REGRESSION';
      } else if (r.doorCount > bl.doors) {
        notes.push(`Doors INCREASED: ${bl.doors} → ${r.doorCount}`);
        status = 'CHANGED';
      }
    }

    if (bl.sets !== null) {
      if (r.setCount < bl.sets) {
        notes.push(`Sets DECREASED: ${bl.sets} → ${r.setCount}`);
        status = 'REGRESSION';
      } else if (r.setCount > bl.sets) {
        notes.push(`Sets INCREASED: ${bl.sets} → ${r.setCount}`);
        status = 'CHANGED';
      }
    }

    const icon = status === 'REGRESSION' ? '🔴' : status === 'CHANGED' ? '🟡' : '🟢';
    const detail = notes.length > 0 ? ` — ${notes.join(', ')}` : '';
    console.log(`  ${icon} ${r.shortName}: ${r.doorCount} doors, ${r.setCount} sets${detail}`);

    if (status === 'REGRESSION') regressions.push(r.shortName);
    else if (status === 'CHANGED') improvements.push(r.shortName);
    else stable.push(r.shortName);
  }

  console.log(`\n  Summary: ${stable.length} stable, ${improvements.length} changed, ${regressions.length} regressions`);
  if (regressions.length > 0) {
    console.log(`  ⚠️  REGRESSIONS: ${regressions.join(', ')}`);
  }

  return { regressions, improvements, stable };
}

// ── Print summary table ──
function printSummary(results) {
  console.log('\n\n═══════════════════════════════════════════════');
  console.log('  EXTRACTION RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════\n');

  const header = 'PDF Name'.padEnd(22) + 'Pages'.padStart(6) + 'Doors'.padStart(7) + 'Sets'.padStart(6) + 'Items'.padStart(7) + 'Time(s)'.padStart(9) + '  Status';
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of results) {
    const status = r.error ? 'ERROR' : 'OK';
    console.log(
      r.shortName.padEnd(22) +
      String(r.pageCount).padStart(6) +
      String(r.doorCount).padStart(7) +
      String(r.setCount).padStart(6) +
      String(r.totalItems).padStart(7) +
      String(r.duration).padStart(9) +
      `  ${status}`
    );
  }

  const totalDoors = results.reduce((s, r) => s + r.doorCount, 0);
  const totalSets = results.reduce((s, r) => s + r.setCount, 0);
  const totalItems = results.reduce((s, r) => s + r.totalItems, 0);
  const totalTime = results.reduce((s, r) => s + r.duration, 0).toFixed(1);
  const errors = results.filter(r => r.error).length;

  console.log('─'.repeat(header.length));
  console.log(`TOTALS:`.padEnd(28) + String(totalDoors).padStart(7) + String(totalSets).padStart(6) + String(totalItems).padStart(7) + String(totalTime).padStart(9));
  console.log(`\n${results.length} PDFs tested, ${errors} errors, ${totalTime}s total`);
}

// ── Main ──
async function main() {
  // Get git commit hash
  let commitHash = 'unknown';
  try {
    commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {}

  console.log('═══════════════════════════════════════════════');
  console.log('  Golden PDF Test Suite — Post-Consolidation');
  console.log(`  Commit: ${commitHash}`);
  console.log(`  Date: ${new Date().toISOString().split('T')[0]}`);
  console.log('═══════════════════════════════════════════════');

  // Verify PDFs exist
  const missing = PDF_CATALOG.filter(e => {
    try { readFileSync(resolve(PDF_DIR, e.filename)); return false; }
    catch { return true; }
  });
  if (missing.length > 0) {
    console.error(`\nMissing PDFs:\n${missing.map(e => `  - ${e.filename}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ All ${PDF_CATALOG.length} PDFs found in ${PDF_DIR}`);

  // Verify service role auth works
  console.log('\n🔐 Using service role key for auth bypass...');
  const healthRes = await fetch(`${BASE_URL}/api/parse-pdf?parseOnly=true`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ pdfBase64: '' }),
  });
  if (healthRes.status === 401) {
    console.error('   Auth FAILED — service role key not accepted');
    process.exit(1);
  }
  console.log(`   Auth OK (health check returned ${healthRes.status})`);

  // Process each PDF
  const results = [];
  for (const entry of PDF_CATALOG) {
    const result = await processPDF(entry);
    results.push(result);

    // Brief pause between requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  // Print results
  printSummary(results);
  compareBaselines(results);

  // Write JSON output for Smartsheet insertion
  const outputPath = resolve(import.meta.dirname, '..', 'scripts', 'golden-suite-results.json');
  const output = results.map(r => ({
    testRun: `S072-${String(results.indexOf(r) + 1).padStart(3, '0')}`,
    date: new Date().toISOString().split('T')[0],
    session: 'S-072',
    pdfName: r.shortName,
    pdfPages: r.pageCount,
    extractedDoors: r.doorCount,
    extractedSets: r.setCount,
    totalItems: r.totalItems,
    flaggedCount: r.flaggedCount,
    duration: r.duration,
    buildCommit: commitHash,
    error: r.error,
    notes: `Post Phases 1-12 consolidation. ${r.setCount} sets, ${r.totalItems} items.${r.error ? ' ERROR: ' + r.error : ''}`,
  }));

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n📝 Results written to ${outputPath}`);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
