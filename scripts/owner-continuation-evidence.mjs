#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { collectPrOwnershipSync } from './mivo-pr-snapshot.mjs';
import { collectMivoCiSync } from './mivo-ci.mjs';
import { readRelease, validateMivoV2, deliveryGh } from './release-mivo-pr.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  if (input.mode === 'ownership') {
    const pr = collectPrOwnershipSync({ pr: { repo: input.repo, number: input.number }, ghFn: deliveryGh });
    process.stdout.write(JSON.stringify({ isDraft: pr.isDraft, state: pr.state, head: pr.headRefOid }));
  } else if (input.mode === 'ci') {
    const pr = collectPrOwnershipSync({ pr: { repo: input.repo, number: input.number }, ghFn: deliveryGh });
    if (pr.headRefOid !== input.head) throw new Error('head changed while waiting CI');
    const ci = collectMivoCiSync({ pr, ghFn: deliveryGh });
    process.stdout.write(JSON.stringify({ status: ci.status, head: pr.headRefOid, isDraft: pr.isDraft, state: pr.state }));
  } else if (input.mode === 'delivery') {
    const receipt = validateMivoV2(JSON.parse(fs.readFileSync(input.receipt)));
    const release = readRelease(input.release);
    if (receipt.releaseReceiptSha256 !== hash(fs.readFileSync(input.release)) || receipt.deliveryHeadSha !== release.deliveryHeadSha
      || receipt.prNodeId !== release.prNodeId || receipt.releaseEpoch !== release.releaseEpoch || receipt.branch !== input.branch
      || receipt.assignment_seq !== input.assignmentSeq || receipt.deliveryHeadSha !== input.head) throw new Error('delivery binding changed');
    process.stdout.write(JSON.stringify({ verified: true, head: receipt.deliveryHeadSha, number: receipt.number }));
  } else throw new Error('unsupported owner evidence mode');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
