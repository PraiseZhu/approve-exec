import { createHash } from 'node:crypto';
const cache = new Set();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, reason) => { if (!ok) throw new Error(`control source: ${reason}`); };

export function controlManifestDigest(manifest) {
  check(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest required');
  const entries = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
  check(entries.length > 0 && entries.length <= 1000, 'manifest size invalid');
  for (const [name, digest] of entries) check(/^[A-Za-z0-9_.\/-]+$/.test(name) && !name.startsWith('/')
    && name.split('/').every(part => part && part !== '.' && part !== '..') && /^[a-f0-9]{64}$/.test(digest), 'invalid manifest entry');
  return hash(Buffer.from(JSON.stringify(entries)));
}

export function* verifyControlSourceSteps({ repo, sha, gh, manifest }) {
  check(/^[\w.-]+\/[\w.-]+$/.test(repo) && /^[a-f0-9]{40}$/.test(sha), 'invalid source identity');
  const manifestDigest = controlManifestDigest(manifest);
  const key = `${repo.toLowerCase()}:${sha}:${manifestDigest}`;
  if (cache.has(key)) return { verified: true, sha, manifestDigest, cached: true };
  const rawTree = yield () => gh(['api', `repos/${repo}/git/trees/${sha}?recursive=1`]);
  const tree = typeof rawTree === 'string' || Buffer.isBuffer(rawTree) ? JSON.parse(String(rawTree)) : rawTree;
  check(tree?.truncated === false && Array.isArray(tree.tree), 'complete control tree required');
  const controlPath = name => {
    if (['.github/workflows/code-review.yml', '.github/workflows/review-readiness.yml'].includes(name)) return true;
    if (!name.startsWith('.github/scripts/') && !name.startsWith('.github/actions/')) return false;
    return !name.split('/').some(part => ['tests', 'node_modules', '__pycache__'].includes(part)) && !name.endsWith('.pyc');
  };
  const files = tree.tree.filter(item => typeof item.path === 'string' && controlPath(item.path) && item.type !== 'tree');
  check(files.every(item => item.type === 'blob' && ['100644', '100755'].includes(item.mode)), 'control symlink or submodule forbidden');
  check(JSON.stringify(files.map(item => item.path).sort()) === JSON.stringify(Object.keys(manifest).sort()), 'control file set mismatch');
  const entries = Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b));
  const [owner, repository] = repo.split('/');
  // Batch immutable blobs without replacing SHA256 verification with a claimed Git OID.
  for (let offset = 0; offset < entries.length; offset += 16) {
    const batch = entries.slice(offset, offset + 16);
    const variables = batch.map((_, index) => `$e${index}:String!`).join(',');
    const selection = batch.map((_, index) => `f${index}:object(expression:$e${index}){__typename ... on Blob{byteSize isBinary text}}`).join(' ');
    const query = `query($owner:String!,$name:String!,${variables}){repository(owner:$owner,name:$name){${selection}}}`;
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${repository}`];
    batch.forEach(([name], index) => args.push('-f', `e${index}=${sha}:${name}`));
    const raw = yield () => gh(args, { maxBytes: 16 * 1024 * 1024 });
    const value = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw;
    check(!value?.errors?.length && value?.data?.repository, 'complete blob batch required');
    for (const [index, [name, digest]] of batch.entries()) {
      const blob = value.data.repository[`f${index}`];
      check(blob?.__typename === 'Blob' && typeof blob.isBinary === 'boolean'
        && Number.isSafeInteger(blob.byteSize) && blob.byteSize >= 0 && blob.byteSize <= 10 * 1024 * 1024, `ordinary bounded file required: ${name}`);
      let bytes = blob.isBinary === false && typeof blob.text === 'string' ? Buffer.from(blob.text, 'utf8') : null;
      // GitHub text can replace invalid UTF8 (the repo has such a fixture). Only raw bytes can prove it.
      if (!bytes || bytes.length !== blob.byteSize || hash(bytes) !== digest) {
        const oid = files.find(file => file.path === name)?.sha;
        check(/^[a-f0-9]{40}$/.test(oid ?? ''), `blob identity required: ${name}`);
        const response = yield () => gh(['api', `repos/${repo}/git/blobs/${oid}`], { maxBytes: 16 * 1024 * 1024 });
        const file = typeof response === 'string' || Buffer.isBuffer(response) ? JSON.parse(String(response)) : response;
        check(file?.sha === oid && file.encoding === 'base64'
          && file.size === blob.byteSize && typeof file.content === 'string', `raw file required: ${name}`);
        bytes = Buffer.from(file.content.replace(/\n/g, ''), 'base64');
      }
      check(bytes.length === blob.byteSize && hash(bytes) === digest, `manifest mismatch: ${name}`);
    }
  }
  cache.add(key);
  return { verified: true, sha, manifestDigest, cached: false };
}

export function verifyControlSourceSync(options) {
  const iterator = verifyControlSourceSteps(options);
  let step = iterator.next();
  while (!step.done) {
    const value = step.value();
    check(!value || typeof value.then !== 'function', 'async transport in sync verifier');
    step = iterator.next(value);
  }
  return step.value;
}

export async function verifyControlSource(options) {
  const iterator = verifyControlSourceSteps(options);
  let step = iterator.next();
  while (!step.done) step = iterator.next(await step.value());
  return step.value;
}
