# QuoxSkills rights terms (distribution)

> Drafted 2026-09-10 (SKILLRIGHTS #478, phase 11). Like the SkillRights licence
> texts themselves, this document was produced with AI assistance and has NOT
> been reviewed by qualified counsel; professional review is planned. It is a
> statement of the terms QuoxSkills operates under, not legal advice.

These terms govern the distribution of agent skills through QuoxSkills
surfaces: skill-pack sync to dev hosts, `quox skills protect`, and any future
listing or exchange surface. They are referenced from every distribution
response (`rightsNotice` on the sync API).

## 1. Declarations travel with the skill

A skill's SkillRights declaration (the `license:` field in its SKILL.md
frontmatter, resolving to a SkillRights licence text) is part of the skill.
QuoxSkills preserves it at every hop: the installer carries it to the
receiving host, records it in the host's rights manifest
(`.pack-rights.json`), and keeps a durable record of what each host received
under which declared terms.

## 2. Distribution records that the terms accompanied the skill, not that anyone assented

> **Superseded 2026-09-11 (external audit).** This section was previously
> titled "Receipt is acceptance" and said: ~~"By receiving a skill through
> QuoxSkills, the receiving organisation accepts that the skill's declared
> terms apply to its use of that skill."~~ That presented a distribution event
> as licence acceptance. No QuoxSkills path captures affirmative assent to an
> identified terms version: the sync handler installs the pack and then returns
> the notice. The old wording stays visible here rather than being rewritten
> out, so the record of what was claimed, and when, survives the correction.

When a skill is distributed through QuoxSkills, QuoxSkills records which
declared terms travelled with it: the declaration in force at the time of
distribution, the receiving host and organisation, and the time. That record
evidences one thing, stated exactly: **the declared terms accompanied the
skill at distribution.**

It does not, by itself, record the recipient's assent to those terms, and
nothing in these terms or on any QuoxSkills surface may imply that it does.
Assent is a separate record, captured by the affirmative acceptance flow in
section 2a, and only where an organisation's distribution policy requires it
(`require-acceptance`). Under any other policy, a distribution evidences
accompaniment and nothing more. Whether the declared terms apply to a
recipient who never assented is a question for contract law and, where it
matters, a tribunal.

An undeclared skill (no `license:` field) grants no rights beyond what the law
provides by default; undeclared is not unrestricted.

## 2a. Affirmative acceptance, where an organisation asks for it

> Added 2026-09-11 (SKILLRIGHTS #478 phase 11). Section 2 above says no
> QuoxSkills path captured assent. This section describes the path that now
> does, and is bounded by exactly what that path records.

An organisation can set its distribution policy to `require-acceptance`. Under
that policy, a pack containing any skill with a declared licence is not
distributed to a host until a person has accepted these terms for that exact
pack. A pack whose skills are all undeclared is unaffected: there are no terms
to accept.

The mechanics, in order:

1. **Offer.** An authenticated user asks for the terms
   (`quox dev skills accept <packId>`). The server presents this document's
   exact bytes, the pack's content hash, the hash of its declared rights, a
   presentation version, and a single-use challenge. Nothing is recorded: an
   offer is not assent.
2. **Assent.** The user reads the terms, which are printed in full, and
   accepts explicitly. The client echoes the challenge and every hash back.
3. **Exact-hash binding.** The acceptance is refused unless every echoed hash
   equals what the challenge was issued for. Nobody can accept something other
   than what was put in front of them, and an old acceptance cannot be
   replayed against a substituted artefact or a re-issued terms document.
4. **Record.** The server stores, append-only: the authenticated person, the
   organisation they represent, the pack and version, the content hash, the
   declared-rights hash, the terms hash, **the terms bytes themselves**, the
   presentation version, the burned challenge, a server timestamp, and a
   reference to the evidence envelope witnessed into the organisation's
   evidence chain. The envelope carries hashes only; the bytes stay on the
   record.
5. **Then, and only then, delivery.** The acceptance is committed before the
   download is authorised, never after.

A change to the pack's content, or to any skill's declaration, produces
different hashes and therefore requires a new acceptance. There is no expiry
and no renewal: a new version is a new thing to agree to.

**A service credential cannot accept.** An automated caller presenting a
machine key is refused (`user_assent_required`). A shared credential proves
that a process ran; it cannot prove that a person agreed. Delegated
acceptance for automation (an automation acting under an acceptance recorded
earlier by a named human) is not built, and until it is, automated sync under
`require-acceptance` is refused rather than quietly treated as assent.

**What an acceptance record proves, exactly:**

> This authenticated actor assented to these identified terms before this
> download was authorized.

**What it does not prove.** It does not prove that the person read or
understood the terms, that they had authority to bind their organisation,
that the licensor owns what they licensed, or that the terms are enforceable
in any particular jurisdiction. Those are questions for contract law and, if
it comes to it, a tribunal. What QuoxSkills holds is the record, and it is
preserved rather than argued.

## 3. Reservation is enforced by contract, policy and evidence, not by magic

A SkillRights declaration is a dated reservation of rights. It is not a
technical shield: nothing in it can physically stop copying or training,
and no QuoxSkills surface may claim otherwise. What QuoxSkills adds is:

- **policy enforcement at distribution time**: an organisation can refuse to
  distribute skills that lack declarations (`require-declaration`), refuse
  cross-organisation distribution of Reserved skills (`respect-reserved`), or
  refuse distribution of any declared skill until a person has affirmatively
  accepted these terms for that exact pack content (`require-acceptance`);
- **stated terms**: this document states the terms QuoxSkills distributes
  under, and every distribution response carries them. Whether they bind a
  particular recipient depends on assent, which is recorded only under
  `require-acceptance` (sections 2 and 2a);
- **evidence**: distributions are witnessed into the organisation's evidence
  chain (AEE envelope, WARD entry), and protected skills additionally carry
  an org signature and an entry in the public SkillRights registry, so what
  was distributed, when, and under which declared terms is provable later.

## 4. What none of this establishes

Neither a declaration, nor a registry entry, nor anything in these terms
establishes legal ownership, authorship or originality of a skill. The
SkillRights registry proves that an artefact existed by a time, that a key
claimed it, and the order of registrations; it records submitted signatures
verbatim and does not verify them. Disputes about who wrote what are for
humans and, if necessary, tribunals; QuoxSkills preserves the evidence and
takes no side.

## 5. Relationship to the open standard

The SkillRights standard, licences, registry and verification tooling are
open and independent of Quox (skillrights.org). QuoxSkills consumes the open
formats and never forks them. Nothing in these terms narrows any right the
open licences grant, and where these terms and a skill's own licence text
disagree, the skill's licence text wins for that skill.
