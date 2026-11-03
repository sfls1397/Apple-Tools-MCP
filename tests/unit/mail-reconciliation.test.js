import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { spawn } from 'child_process'
import { once } from 'events'
import { idempotentMailSend } from '../../lib/mailIdempotency.js'
import {
  mailFingerprint, mailClaimId, mailSendReconcile, FINGERPRINT_ALGORITHM,
  claimBinding, readMailClaim, protectedMailAuthority, reconciliationFencePath, fencedMailWrite
} from '../../lib/mailReconciliation.js'
import { dispatchWriteTool, mcpWriteResult, WRITE_TOOL_DEFINITIONS, loggedBridgeHandler } from '../../lib/writeTools.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const args = { to: ['fixture@example.com'], subject: 'Synthetic fixture', body: 'Offline payload', idempotency_key: 'fixture-key' }
const epoch = 'deployment_v1'
const account = hash('account')
const time = 1000000

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-reconcile-'))
  const fingerprint = mailFingerprint(args)
  const id = mailClaimId(fingerprint, args.idempotency_key)
  const records = new Map()
  const load = vi.fn((kind, reference) => {
    const record = records.get(`${kind}:${reference}`)
    if (!record) throw Error('not protected or unavailable')
    return structuredClone(record)
  })
  const authority = { load }
  const deps = { directory, authority, now: () => time, log: () => {} }
  idempotentMailSend(args, () => ({ ok: false, unconfirmed: true }), deps)
  const original = fs.readFileSync(path.join(directory, id, '1.json'), 'utf8')
  const target = claimBinding(readMailClaim(directory, id, 1))
  const put = (kind, record) => {
    const reference = hash(JSON.stringify(record))
    records.set(`${kind}:${reference}`, record)
    return reference
  }
  const fresh = { schema_version: 1, issued_at: time - 1000, expires_at: time + 59000, revoked: false }
  const deployment = {
    ...fresh, kind: 'deployment', epoch, accounts: [account], operators: ['operator_one'], clock_uncertainty_ms: 0, nonparticipating_launch_disabled: true,
    excluded: Object.fromEntries(['daemon', 'local_fallback', 'accepted_bridge', 'scripts_appleevents', 'old_processes', 'outstanding_effects'].map(writer => [writer, true]))
  }
  const approval = { ...fresh, ...target, kind: 'reconcile', id: hash('approval'), operator: 'operator_one', epoch }
  const beginArgs = { ...target, action: 'begin', deployment_ref: put('deployment', deployment), approval_ref: put('approval', approval) }
  const begin = () => mailSendReconcile(beginArgs, deps)
  const prepare = (outcome = 'not_sent') => {
    const begun = begin()
    const observation = { completed: true, error: null, index_used: false, observed_at: time + 1, search_from: time, search_to: time + 1, exact_fingerprint: fingerprint, accounts: [account], matches: [] }
    const evidence = { ...fresh, issued_at: time + 1, ...target, kind: 'mail_verification', id: hash('evidence'), fence_id: begun.mail_send.fence_id, epoch,
      operator: 'operator_one', source: 'complete_exact_mail_snapshot_v1', clock_uncertainty_ms: 0, outcome, reason_code: `operator_verified_${outcome}`, effects_drained: true,
      sent: structuredClone(observation), outbox: structuredClone(observation) }
    if (outcome === 'sent') {
      evidence.message_id_hash = hash('message-id')
      evidence.sent.matches.push({ message_ref: hash('message-reference'), message_id_hash: evidence.message_id_hash, account, fingerprint })
    }
    const commit = { ...beginArgs, action: 'commit', fence_id: begun.mail_send.fence_id, outcome, reason_code: evidence.reason_code, evidence_ref: put('evidence', evidence) }
    return { commit, evidence, commitDeps: { ...deps, now: () => time + 2 } }
  }
  return { directory, id, fingerprint, original, target, records, authority, deps, put, fresh, deployment, approval, beginArgs, begin, prepare }
}

function code(result) { return result.mail_send.code }

describe('reconciliation identity and immutable lineage', () => {
  it('publishes the distinct no-send operation and external structured schema', () => {
    expect(WRITE_TOOL_DEFINITIONS.find(tool => tool.name === 'mail_send_reconcile').inputSchema.additionalProperties).toBe(false)
    const sample = fixture()
    const result = mailSendReconcile({ ...sample.beginArgs, revision: 2 }, sample.deps)
    expect(code(result)).toBe('revision_refused')
    expect(mcpWriteResult(result)).toMatchObject({ isError: true, structuredContent: { mail_send: { schema_version: 1, current_invocation_transport: 'none', ledger_action: 'none', retry_authorized: false } } })
  })
  it.each([
    ['claim_id', hash('missing')], ['attempt', 2], ['revision', 2], ['fingerprint', hash('changed')],
    ['fingerprint_algorithm', 'sha256-v0'], ['idempotency_key', 'replacement'], ['extra', 'unchecked']
  ])('refuses altered or absent %s without invoking authority or transport', (field, value) => {
    const sample = fixture()
    const result = mailSendReconcile({ ...sample.beginArgs, [field]: value }, sample.deps)
    expect(result.ok).toBe(false)
    expect(result.mail_send.current_invocation_transport).toBe('none')
    expect(sample.authority.load).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(sample.directory, sample.id, '1.json'), 'utf8')).toBe(sample.original)
  })
  it('requires an existing claim, never creates one, and never upgrades legacy pending claims', () => {
    const sample = fixture()
    const initial = path.join(sample.directory, sample.id, '1.json')
    fs.writeFileSync(initial, JSON.stringify({ fingerprint: sample.fingerprint, createdAt: 0, state: 'pending' }))
    expect(code(sample.begin())).toBe('legacy_ineligible')
    expect(sample.authority.load).not.toHaveBeenCalled()
    expect(fs.readdirSync(path.join(sample.directory, sample.id))).toEqual(['1.json'])
    const missing = path.join(sample.directory, 'does-not-exist')
    expect(mailSendReconcile(sample.beginArgs, { ...sample.deps, directory: missing }).ok).toBe(false)
    expect(fs.existsSync(missing)).toBe(false)
  })
  it('treats replacement or removed keys as the same unresolved content lineage', () => {
    const sample = fixture()
    const transport = vi.fn()
    for (const idempotency_key of ['replacement', undefined]) {
      expect(code(idempotentMailSend({ ...args, idempotency_key }, transport, sample.deps))).toBe('pending_suppressed')
    }
    expect(transport).not.toHaveBeenCalled()
  })
  it('commits terminal not_sent with audit, preserves originals and replays only identical requests', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    const result = mailSendReconcile(commit, commitDeps)
    expect(code(result)).toBe('reconciled')
    expect(code(mailSendReconcile(commit, commitDeps))).toBe('reconciliation_replayed')
    expect(mailSendReconcile(commit, commitDeps).mail_send.receipt).toBe(result.mail_send.receipt)
    expect(code(mailSendReconcile({ ...commit, outcome: 'sent' }, commitDeps))).toBe('outcome_conflict')
    expect(fs.readFileSync(path.join(sample.directory, sample.id, '1.json'), 'utf8')).toBe(sample.original)
    const transport = vi.fn()
    for (const idempotency_key of [args.idempotency_key, 'another', undefined]) {
      const replay = idempotentMailSend({ ...args, idempotency_key, confirm: true }, transport, commitDeps)
      expect(code(replay)).toBe('not_sent_suppressed')
      expect(replay.sendStarted).toBe(false)
    }
    expect(transport).not.toHaveBeenCalled()
    expect(fs.readdirSync(path.join(sample.directory, sample.id)).sort()).toEqual(['1.events', '1.json'])
  })
})

describe('protected evidence and complete writer exclusion', () => {
  it('validates protected reference hashes, ownership, permissions, ancestors and revocation without privileged writes', () => {
    const sample = fixture()
    const root = fs.realpathSync(sample.directory)
    fs.mkdirSync(path.join(root, 'deployment'))
    const raw = JSON.stringify(sample.deployment)
    const reference = hash(raw)
    const file = path.join(root, 'deployment', `${reference}.json`)
    fs.writeFileSync(file, raw)
    const revocations = path.join(root, 'revocations.json')
    fs.writeFileSync(revocations, JSON.stringify({ schema_version: 1, references: [], ids: [] }))
    const realStat = fs.lstatSync
    let invalid
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(location => {
      const stat = realStat(location)
      const bad = location === file && invalid
      return { size: stat.size, uid: bad === 'owner' ? 501 : 0, mode: (stat.mode & ~0o022) | (bad === 'writable' ? 0o020 : 0),
        isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => bad === 'symlink' }
    })
    try {
      const authority = protectedMailAuthority(root)
      expect(authority.load('deployment', reference)).toEqual(sample.deployment)
      for (invalid of ['owner', 'writable', 'symlink']) expect(() => authority.load('deployment', reference)).toThrow()
      invalid = undefined
      fs.writeFileSync(file, '{}')
      expect(() => authority.load('deployment', reference)).toThrow()
      fs.writeFileSync(file, raw)
      fs.writeFileSync(revocations, JSON.stringify({ schema_version: 1, references: [reference], ids: [] }))
      expect(() => authority.load('deployment', reference)).toThrow()
      fs.rmSync(revocations)
      expect(() => authority.load('deployment', reference)).toThrow()
    } finally { spy.mockRestore() }
  })
  it('does not trust caller-authored checked strings or writable local references', () => {
    const sample = fixture()
    const untrusted = protectedMailAuthority(sample.directory)
    expect(mailSendReconcile(sample.beginArgs, { ...sample.deps, authority: untrusted }).ok).toBe(false)
    expect(mailSendReconcile({ ...sample.beginArgs, approval_ref: 'checked' }, sample.deps).ok).toBe(false)
    expect(fs.existsSync(reconciliationFencePath(sample.directory))).toBe(false)
  })
  it.each(['daemon', 'local_fallback', 'accepted_bridge', 'scripts_appleevents', 'old_processes', 'outstanding_effects'])('refuses missing %s exclusion; PID, age and lease assertions supply no proof', writer => {
    const sample = fixture()
    sample.deployment.excluded[writer] = false
    sample.deployment.pid = process.pid
    sample.deployment.lease_expired = true
    sample.beginArgs.deployment_ref = sample.put('deployment', sample.deployment)
    expect(code(sample.begin())).toBe('active_writer_refused')
    expect(fs.existsSync(reconciliationFencePath(sample.directory))).toBe(false)
  })
  it('fences before collecting evidence, excludes a queued writer, and leaves the fence on refusal', async () => {
    const sample = fixture()
    const begun = sample.begin()
    expect(code(begun)).toBe('evidence_required')
    expect(sample.begin().mail_send.fence_id).toBe(begun.mail_send.fence_id)
    const transport = vi.fn()
    const queued = await dispatchWriteTool('mail_send', args, {
      probe: async () => true,
      request: async () => ({ delivered: true, response: idempotentMailSend(args, transport, sample.deps) }),
      runLocally: transport
    })
    expect(code(queued)).toBe('active_writer_refused')
    expect(transport).not.toHaveBeenCalled()
    expect(code(fencedMailWrite(transport, sample.deps))).toBe('active_writer_refused')
    const { commit, evidence, commitDeps } = sample.prepare()
    evidence.sent.observed_at = time
    commit.evidence_ref = sample.put('evidence', evidence)
    expect(code(mailSendReconcile(commit, commitDeps))).toBe('evidence_refused')
    expect(fs.existsSync(reconciliationFencePath(sample.directory))).toBe(true)
  })
  it.each([
    ['missing', evidence => { delete evidence.sent }],
    ['outbox missing', evidence => { delete evidence.outbox }],
    ['sent failure', evidence => { evidence.sent.error = 'unavailable' }],
    ['outbox failure', evidence => { evidence.outbox.error = 'unavailable' }],
    ['partial sent scan', evidence => { evidence.sent.completed = false }],
    ['partial outbox scan', evidence => { evidence.outbox.completed = false }],
    ['partial accounts', evidence => { evidence.sent.accounts = [] }],
    ['outbox accounts', evidence => { evidence.outbox.accounts = [] }],
    ['stale index', evidence => { evidence.sent.index_used = true }],
    ['pre-fence scan', evidence => { evidence.outbox.observed_at = time - 1 }],
    ['clock skew', evidence => { evidence.clock_uncertainty_ms = 1 }],
    ['future scan', evidence => { evidence.sent.observed_at = time + 100 }],
    ['historical cutoff', evidence => { evidence.sent.search_from = time + 1 }],
    ['short search', evidence => { evidence.outbox.search_to-- }],
    ['unknown source', evidence => { evidence.source = 'mail_find' }],
    ['expired evidence', evidence => { evidence.expires_at = time + 1 }],
    ['stale evidence', evidence => { evidence.issued_at = time - 60001 }],
    ['binding mismatch', evidence => { evidence.fingerprint = hash('other') }],
    ['fence mismatch', evidence => { evidence.fence_id = hash('other') }],
    ['operator mismatch', evidence => { evidence.operator = 'other' }],
    ['epoch mismatch', evidence => { evidence.epoch = 'old' }],
    ['no effects drain', evidence => { evidence.effects_drained = false }],
    ['queued delivery', evidence => { evidence.outbox.matches = [{}] }],
    ['ambiguous sent', evidence => { evidence.sent.matches = [{}, {}] }],
    ['negative alone', evidence => { delete evidence.outcome }],
    ['wrong decision', evidence => { evidence.outcome = 'sent' }],
    ['revoked', evidence => { evidence.revoked = true }]
  ])('refuses %s without changing any claim', (_name, change) => {
    const sample = fixture()
    const { commit, evidence, commitDeps } = sample.prepare()
    change(evidence)
    commit.evidence_ref = sample.put('evidence', evidence)
    expect(code(mailSendReconcile(commit, commitDeps))).toBe('evidence_refused')
    expect(readMailClaim(sample.directory, sample.id, 1).state).toBe('pending')
  })
  it('links a unique exact sent message, refusing Message-ID mismatches and mailbox ambiguity', () => {
    for (const mutation of [evidence => { evidence.sent.matches[0].message_id_hash = hash('wrong') }, evidence => { evidence.sent.matches.push(evidence.sent.matches[0]) }, evidence => { evidence.sent.matches[0].account = hash('uncovered') }]) {
      const sample = fixture()
      const { commit, evidence, commitDeps } = sample.prepare('sent')
      mutation(evidence)
      commit.evidence_ref = sample.put('evidence', evidence)
      expect(code(mailSendReconcile(commit, commitDeps))).toBe('evidence_refused')
    }
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare('sent')
    expect(code(mailSendReconcile(commit, commitDeps))).toBe('reconciled')
    expect(readMailClaim(sample.directory, sample.id, 1).reconciliation.message_ref).toBe(hash('message-reference'))
    expect(code(idempotentMailSend(args, vi.fn(), commitDeps))).toBe('accepted_replay')
  })
})

describe('append-only durability, crash recovery and single-use retry approval', () => {
  it.each(['writeFileSync', 'fsyncSync', 'unlinkSync'])('fails closed at %s and never sends', operation => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    const io = Object.create(fs)
    io[operation] = () => { throw Error('injected disk failure') }
    expect(code(mailSendReconcile(commit, { ...commitDeps, io }))).toBe('durability_refused')
    const transport = vi.fn()
    expect(idempotentMailSend(args, transport, sample.deps).ok).toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })
  it.each([1, 2, 3, 4])('fails closed at reconciliation synchronization boundary %s and resynchronizes complete receipts before replay', boundary => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    const io = Object.create(fs)
    let calls = 0
    io.fsyncSync = descriptor => { if (++calls === boundary) throw Error('failed synchronization'); fs.fsyncSync(descriptor) }
    expect(code(mailSendReconcile(commit, { ...commitDeps, io }))).toBe('durability_refused')
    const transport = vi.fn()
    expect(idempotentMailSend(args, transport, commitDeps).ok).toBe(false)
    expect(transport).not.toHaveBeenCalled()
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Error('disk remains unavailable') })
    try { expect(mailSendReconcile(commit, commitDeps).ok).toBe(false) } finally { spy.mockRestore() }
    const replay = mailSendReconcile(commit, commitDeps)
    expect(['active_writer_refused', 'reconciliation_replayed']).toContain(code(replay))
  })
  it('blocks torn journal records and orphan locks; never expires or takes over a lock', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    const journal = path.join(sample.directory, sample.id, '1.events')
    fs.mkdirSync(journal)
    fs.writeFileSync(path.join(journal, '2.json'), '{')
    expect(code(mailSendReconcile(commit, commitDeps))).toBe('durability_refused')
    fs.rmSync(journal, { recursive: true })
    fs.mkdirSync(path.join(sample.directory, '.writer-lock'))
    expect(code(mailSendReconcile(commit, { ...commitDeps, now: () => time + 86400000 }))).toBe('active_writer_refused')
  })
  it('has no separate mutable audit/state reset and recovers a committed receipt after lost reply', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    const io = Object.create(fs)
    io.unlinkSync = () => { throw Error('crash after commit') }
    expect(code(mailSendReconcile(commit, { ...commitDeps, io }))).toBe('durability_refused')
    const replay = mailSendReconcile(commit, commitDeps)
    expect(code(replay)).toBe('reconciliation_replayed')
    expect(replay.mail_send.receipt).toMatch(/^[a-f0-9]{64}$/)
    expect(fs.existsSync(path.join(sample.directory, '.writer-lock'))).toBe(true)
  })
  it('rejects audit/state divergence, missing events and contradictory hash chains', () => {
    for (const alteration of [event => { event.previous_hash = hash('unrelated') }, event => { event.revision++ }, event => { event.state = 'retryable' }, event => { event.fingerprint = hash('other') }]) {
      const sample = fixture()
      const { commit, commitDeps } = sample.prepare()
      mailSendReconcile(commit, commitDeps)
      const file = path.join(sample.directory, sample.id, '1.events', '2.json')
      const event = JSON.parse(fs.readFileSync(file, 'utf8'))
      alteration(event)
      fs.writeFileSync(file, JSON.stringify(event))
      expect(code(mailSendReconcile(commit, commitDeps))).toBe('durability_refused')
      expect(idempotentMailSend(args, vi.fn(), commitDeps).ok).toBe(false)
    }
  })
  it('revalidates authority immediately before commit when a late writer or revocation invalidates evidence', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    const load = sample.authority.load
    let deployments = 0
    sample.authority.load = (kind, reference) => {
      const record = load(kind, reference)
      if (kind === 'deployment' && ++deployments === 2) record.excluded.outstanding_effects = false
      return record
    }
    expect(code(mailSendReconcile(commit, commitDeps))).toBe('active_writer_refused')
    expect(readMailClaim(sample.directory, sample.id, 1).state).toBe('pending')
  })
  it('requires separate approval and consumes it before transport; a lost reply never restores it', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const authorization = { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('authorization'), single_use: true, operator: 'operator_one', epoch }
    const reference = sample.put('authorization', authorization)
    const request = { ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }
    const transport = vi.fn(() => {
      const consumed = JSON.parse(fs.readFileSync(path.join(sample.directory, sample.id, '2.json'), 'utf8'))
      expect(consumed.authorization_id).toBe(authorization.id)
      expect(code(idempotentMailSend(request, vi.fn(), commitDeps))).toBe('active_writer_refused')
      throw Error('lost reply')
    })
    expect(code(idempotentMailSend(request, transport, commitDeps))).toBe('transport_unresolved')
    expect(code(idempotentMailSend(request, transport, commitDeps))).toBe('pending_suppressed')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(readMailClaim(sample.directory, sample.id, 1).state).toBe('not_sent')
  })
  it.each(['id', 'kind', 'fingerprint', 'revision', 'operator', 'epoch', 'single_use', 'revoked', 'expires_at'])('rejects invalid retry %s before allocating an attempt', field => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const authorization = { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('authorization'), single_use: true, operator: 'operator_one', epoch }
    authorization[field] = field === 'revoked' ? true : field === 'single_use' ? false : field === 'expires_at' ? 0 : 'invalid'
    const reference = sample.put('authorization', authorization)
    const transport = vi.fn()
    expect(code(idempotentMailSend({ ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }, transport, commitDeps))).toBe('authorization_refused')
    expect(transport).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(sample.directory, sample.id, '2.json'))).toBe(false)
  })
  it('does not restore permission after a proven-unstarted authorized invocation', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const reference = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('authorization'), single_use: true, operator: 'operator_one', epoch })
    const request = { ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }
    const transport = vi.fn(() => ({ ok: false, sendStarted: false }))
    const result = idempotentMailSend(request, transport, commitDeps)
    expect(result.mail_send.current_invocation_transport).toBe('entered')
    expect(code(idempotentMailSend(request, transport, commitDeps))).toBe('pending_suppressed')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(readMailClaim(sample.directory, sample.id, 2).state).toBe('pending')
  })
  it('records actual ordinary handler entry separately from proof that sending did not start', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-entry-'))
    const transport = vi.fn(() => ({ ok: false, sendStarted: false }))
    const result = idempotentMailSend(args, transport, { directory, log() {} })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(result.mail_send.current_invocation_transport).toBe('entered')
    expect(result.sendStarted).toBe(false)
  })
  it('rejects a second grant even after an authorized retry is reconciled to not_sent', () => {
    const sample = fixture()
    const { commit, evidence, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const grant = { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('grant-a'), single_use: true, operator: 'operator_one', epoch }
    const request = { ...args, retry_authorization_ref: sample.put('authorization', grant), deployment_ref: sample.beginArgs.deployment_ref }
    const transport = vi.fn(() => ({ ok: false, sendStarted: false }))
    idempotentMailSend(request, transport, commitDeps)
    const retry = readMailClaim(sample.directory, sample.id, 2)
    const beginArgs = { ...sample.beginArgs, ...claimBinding(retry), approval_ref: sample.put('approval', { ...sample.approval, ...claimBinding(retry), id: hash('second-adjudication') }) }
    const begun = mailSendReconcile(beginArgs, { ...sample.deps, now: () => time + 3 })
    expect(code(begun)).toBe('evidence_required')
    const secondEvidence = { ...evidence, ...claimBinding(retry), id: hash('second-evidence'), fence_id: begun.mail_send.fence_id, issued_at: time + 4,
      sent: { ...evidence.sent, observed_at: time + 4, search_to: time + 4 }, outbox: { ...evidence.outbox, observed_at: time + 4, search_to: time + 4 } }
    const secondCommit = { ...beginArgs, action: 'commit', fence_id: begun.mail_send.fence_id, outcome: 'not_sent', reason_code: 'operator_verified_not_sent', evidence_ref: sample.put('evidence', secondEvidence) }
    const laterDeps = { ...sample.deps, now: () => time + 5 }
    expect(code(mailSendReconcile(secondCommit, laterDeps))).toBe('reconciled')
    const secondTerminal = readMailClaim(sample.directory, sample.id, 2)
    const grantB = { ...grant, ...claimBinding(secondTerminal), id: hash('grant-b') }
    expect(code(idempotentMailSend({ ...request, retry_authorization_ref: sample.put('authorization', grantB) }, transport, laterDeps))).toBe('authorization_refused')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(sample.directory, sample.id, '3.json'))).toBe(false)
  })
  it('cannot enter transport on consumption failure, including torn claim, file fsync or directory fsync', () => {
    for (const boundary of [2, 3, 4, 5, 6]) {
      const sample = fixture()
      const { commit, commitDeps } = sample.prepare()
      mailSendReconcile(commit, commitDeps)
      const terminal = readMailClaim(sample.directory, sample.id, 1)
      const reference = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('authorization'), single_use: true, operator: 'operator_one', epoch })
      const io = Object.create(fs)
      let calls = 0
      io.fsyncSync = descriptor => { if (++calls === boundary) throw Error('power failure'); fs.fsyncSync(descriptor) }
      const transport = vi.fn()
      const request = { ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }
      expect(idempotentMailSend(request, transport, { ...commitDeps, io }).ok).toBe(false)
      idempotentMailSend(request, transport, commitDeps)
      expect(transport).not.toHaveBeenCalled()
    }
  })
  it.each(['torn', 'filename', 'schema_version', 'authorization_id', 'authorization_ref', 'retry_attempt', 'consumed_at', 'symlink'])('refuses malformed consumption audit %s before handler entry', alteration => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const reference = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('new-authorization'), single_use: true, operator: 'operator_one', epoch })
    const consumed = path.join(sample.directory, '.authorizations')
    fs.mkdirSync(consumed)
    const record = { schema_version: 1, ...claimBinding(terminal), claim_id: hash('unrelated'), authorization_id: hash('old-authorization'), authorization_ref: hash('old-reference'), retry_attempt: 2, consumed_at: time }
    if (['schema_version', 'authorization_id', 'authorization_ref', 'retry_attempt', 'consumed_at'].includes(alteration)) record[alteration] = null
    record.integrity_hash = hash(JSON.stringify(record))
    const file = path.join(consumed, alteration === 'filename' ? 'invalid.json' : `${hash('old-authorization')}.json`)
    if (alteration === 'symlink') fs.symlinkSync(path.join(sample.directory, sample.id, '1.json'), file)
    else fs.writeFileSync(file, alteration === 'torn' ? '{' : JSON.stringify(record))
    const transport = vi.fn()
    expect(idempotentMailSend({ ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }, transport, commitDeps).ok).toBe(false)
    expect(transport).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(sample.directory, sample.id, '2.json'))).toBe(false)
  })
  it('does not confuse an intact unrelated consumption record with the requested lineage', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const reference = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('new-authorization'), single_use: true, operator: 'operator_one', epoch })
    const consumed = path.join(sample.directory, '.authorizations')
    fs.mkdirSync(consumed)
    const record = { schema_version: 1, ...claimBinding(terminal), claim_id: hash('unrelated'), authorization_id: hash('old-authorization'), authorization_ref: hash('old-reference'), retry_attempt: 2, consumed_at: time }
    record.integrity_hash = hash(JSON.stringify(record))
    fs.writeFileSync(path.join(consumed, `${record.authorization_id}.json`), JSON.stringify(record))
    const transport = vi.fn(() => ({ ok: true }))
    expect(code(idempotentMailSend({ ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }, transport, commitDeps))).toBe('transport_accepted')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it.each(['claim_id', 'fingerprint', 'authorization_ref', 'consumed_at', 'missing_integrity'])('refuses valid-shape consumption corruption of %s after a pre-attempt crash', field => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const reference = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('authorization'), single_use: true, operator: 'operator_one', epoch })
    const request = { ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }
    const io = Object.create(fs)
    io.openSync = (file, ...options) => {
      if (file === path.join(sample.directory, sample.id, '2.json')) throw Error('crash before attempt')
      return fs.openSync(file, ...options)
    }
    const transport = vi.fn()
    expect(idempotentMailSend(request, transport, { ...commitDeps, io }).ok).toBe(false)
    fs.rmdirSync(path.join(sample.directory, '.writer-lock'))
    const file = path.join(sample.directory, '.authorizations', `${hash('authorization')}.json`)
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (field === 'missing_integrity') delete record.integrity_hash
    else record[field] = field === 'consumed_at' ? record[field] + 1 : `${record[field][0] === 'a' ? 'b' : 'a'}${record[field].slice(1)}`
    fs.writeFileSync(file, JSON.stringify(record))
    const alternate = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('alternate-after-corruption'), single_use: true, operator: 'operator_one', epoch })
    expect(code(idempotentMailSend({ ...request, retry_authorization_ref: alternate }, transport, commitDeps))).toBe('durability_refused')
    expect(transport).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(sample.directory, sample.id, '2.json'))).toBe(false)
  })
  it('sacrifices permission on a crash after consumption and before attempt creation', () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const reference = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('authorization'), single_use: true, operator: 'operator_one', epoch })
    const request = { ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }
    const io = Object.create(fs)
    io.openSync = (file, ...options) => {
      if (file === path.join(sample.directory, sample.id, '2.json')) throw Error('crash before attempt')
      return fs.openSync(file, ...options)
    }
    const transport = vi.fn()
    expect(idempotentMailSend(request, transport, { ...commitDeps, io }).ok).toBe(false)
    expect(fs.existsSync(path.join(sample.directory, '.authorizations', `${hash('authorization')}.json`))).toBe(true)
    fs.rmdirSync(path.join(sample.directory, '.writer-lock'))
    expect(idempotentMailSend(request, transport, commitDeps).ok).toBe(false)
    const alternate = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('alternate-after-crash'), single_use: true, operator: 'operator_one', epoch })
    expect(code(idempotentMailSend({ ...request, retry_authorization_ref: alternate }, transport, commitDeps))).toBe('authorization_refused')
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('offline process barriers and safe external outcomes', () => {
  it('consumes a retry approval at most once across independent processes with a lost reply', async () => {
    const sample = fixture()
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const terminal = readMailClaim(sample.directory, sample.id, 1)
    const reference = sample.put('authorization', { ...sample.fresh, ...claimBinding(terminal), kind: 'retry', id: hash('authorization'), single_use: true, operator: 'operator_one', epoch })
    const request = { ...args, retry_authorization_ref: reference, deployment_ref: sample.beginArgs.deployment_ref }
    const moduleUrl = new URL('../../lib/mailIdempotency.js', import.meta.url).href
    const countFile = path.join(sample.directory, 'transport-count')
    const program = `
      import fs from 'fs'; import { idempotentMailSend } from ${JSON.stringify(moduleUrl)};
      const records = new Map(${JSON.stringify([...sample.records])}); process.stdout.write('ready\\n');
      process.stdin.once('data', () => {
        const result = idempotentMailSend(${JSON.stringify(request)}, () => {
          fs.appendFileSync(${JSON.stringify(countFile)}, 'entry\\n'); throw Error('lost reply');
        }, { directory: ${JSON.stringify(sample.directory)}, now: () => ${time + 2}, log() {},
          authority: { load(kind, reference) { return records.get(kind + ':' + reference); } }
        }); process.stdout.write(JSON.stringify(result) + '\\n');
      });
    `
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe'] }))
    try {
      await Promise.all(children.map(child => once(child.stdout, 'data')))
      const exits = children.map(child => once(child, 'exit'))
      for (const child of children) child.stdin.end('go')
      expect(await Promise.all(exits)).toEqual([[0, null], [0, null]])
      expect(fs.readFileSync(countFile, 'utf8')).toBe('entry\n')
      expect(code(idempotentMailSend(request, vi.fn(), commitDeps))).toBe('pending_suppressed')
    } finally { for (const child of children) if (child.exitCode === null) child.kill() }
  })
  it('runs simultaneous independent reconcilers against one audit commit and returns one receipt', async () => {
    const sample = fixture()
    const { commit } = sample.prepare()
    const moduleUrl = new URL('../../lib/mailReconciliation.js', import.meta.url).href
    const program = `
      import { mailSendReconcile } from ${JSON.stringify(moduleUrl)};
      const records = new Map(${JSON.stringify([...sample.records])});
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => {
        const result = mailSendReconcile(${JSON.stringify(commit)}, {
          directory: ${JSON.stringify(sample.directory)}, now: () => ${time + 2},
          authority: { load(kind, reference) { const value = records.get(kind + ':' + reference); if (!value) throw Error('missing'); return value; } }
        }); process.stdout.write(JSON.stringify(result) + '\\n');
      });
    `
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe'] }))
    const output = children.map(() => '')
    for (let index = 0; index < children.length; index++) children[index].stdout.on('data', chunk => { output[index] += chunk.toString() })
    try {
      await Promise.all(children.map(child => once(child.stdout, 'data')))
      const exits = children.map(child => once(child, 'exit'))
      for (const child of children) child.stdin.end('go')
      expect(await Promise.all(exits)).toEqual([[0, null], [0, null]])
      const results = output.map(text => JSON.parse(text.trim().split('\n').at(-1)))
      expect(results.some(result => code(result) === 'reconciled')).toBe(true)
      expect(results.every(result => ['reconciled', 'reconciliation_replayed', 'active_writer_refused'].includes(code(result)))).toBe(true)
      expect(fs.readdirSync(path.join(sample.directory, sample.id, '1.events'))).toEqual(['2.json'])
      const replay = mailSendReconcile(commit, { ...sample.deps, now: () => time + 2 })
      expect(code(replay)).toBe('reconciliation_replayed')
    } finally { for (const child of children) if (child.exitCode === null) child.kill() }
  })
  it('excludes another process while a writer owns the lock, even if its client timed out', async () => {
    const sample = fixture()
    const moduleUrl = new URL('../../lib/mailReconciliation.js', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'fs'; import { withMailWriterLock } from ${JSON.stringify(moduleUrl)};
      withMailWriterLock(${JSON.stringify(sample.directory)}, () => {
        process.stdout.write('owned\\n'); fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await once(child.stdout, 'data')
      expect(code(sample.begin())).toBe('active_writer_refused')
      expect(code(idempotentMailSend(args, vi.fn(), sample.deps))).toBe('active_writer_refused')
      child.stdin.end('x')
      const [exit] = await once(child, 'exit')
      expect(exit).toBe(0)
      expect(code(sample.begin())).toBe('evidence_required')
    } finally { if (child.exitCode === null) child.kill() }
  })
  it('distinguishes suppression, attempted transport, accepted replay, terminal suppression and bridge ambiguity', async () => {
    const sample = fixture()
    const suppressed = idempotentMailSend(args, vi.fn(), sample.deps)
    expect(suppressed.mail_send).toMatchObject({ code: 'pending_suppressed', current_invocation_transport: 'none' })
    const other = { ...args, body: 'New content', idempotency_key: 'new-content' }
    const attempted = idempotentMailSend(other, () => ({ ok: false }), sample.deps)
    expect(attempted.mail_send).toMatchObject({ code: 'transport_unresolved', current_invocation_transport: 'entered' })
    const ambiguous = await dispatchWriteTool('mail_send', args, { probe: async () => true, request: async () => ({ delivered: false, mayHaveStarted: true }), runLocally: vi.fn() })
    expect(ambiguous.mail_send).toMatchObject({ code: 'bridge_uncertain', current_invocation_transport: 'unknown' })
    const noSend = await dispatchWriteTool('mail_send_reconcile', sample.beginArgs, { probe: async () => true, request: async () => ({ delivered: false, mayHaveStarted: true }), runLocally: vi.fn() })
    expect(noSend.mail_send.current_invocation_transport).toBe('none')
    const logs = []
    await loggedBridgeHandler(async () => suppressed, line => logs.push(line))('mail_send', args)
    expect(logs.join(' ')).toContain('pending_suppressed')
    expect(logs.join(' ')).not.toContain('sent; not yet seen')
  })
  it('keeps logs and durable records payload-free; log failure cannot grant eligibility', () => {
    const sample = fixture()
    const logs = []
    const delivery = { ...args, idempotency_key: 'new-key', body: 'Another synthetic body' }
    idempotentMailSend(delivery, () => ({ ok: true }), { ...sample.deps, log: record => logs.push(record) })
    expect(logs.map(record => record.stage)).toEqual(['handler_entered', 'handler_completed', 'verification_completed'])
    const { commit, commitDeps } = sample.prepare()
    mailSendReconcile(commit, commitDeps)
    const collect = directory => fs.readdirSync(directory).flatMap(name => {
      const file = path.join(directory, name)
      return fs.statSync(file).isDirectory() ? collect(file) : [fs.readFileSync(file, 'utf8')]
    })
    const durable = JSON.stringify([collect(sample.directory), logs])
    for (const value of [...args.to, args.subject, args.body, args.idempotency_key, delivery.body, delivery.idempotency_key]) expect(durable).not.toContain(value)
    const transport = vi.fn()
    expect(code(idempotentMailSend(args, transport, { ...commitDeps, log: () => { throw Error('log unavailable') } }))).toBe('not_sent_suppressed')
    expect(transport).not.toHaveBeenCalled()
  })
})
