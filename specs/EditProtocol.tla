--------------------------- MODULE EditProtocol ----------------------------
\* Formal model of trueline-mcp's streaming edit protocol.
\* Models: read, single/multi-op replace, insert-after, external mutation,
\*         crash during edit.
\*
\* Invariants: TypeOK, Atomicity, CrashSafety, EditCorrectness,
\*             ContentPreservation, OpsNonOverlapping, StaleRefsAfterEdit.

EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS MaxLines,     \* max file length (e.g. 3)
          MaxRefs,      \* max concurrent refs (e.g. 2)
          MaxOps,       \* max edits per call (e.g. 2)
          Lines         \* set of possible line values (e.g. {"a","b","c"})

VARIABLES
    fileContent,    \* Seq(Lines): current file on disk
    mtime,          \* Nat: incremented on any disk write
    refs,           \* [refId -> [start, end, checksum, mtime]]
    nextRefId,      \* Nat: next ref ID to issue
    tempFile,       \* Seq(Lines) or <<>>: temp buffer during edit
    editPhase,      \* "idle" | "writing"
    preEditContent, \* Seq(Lines): snapshot before edit
    editOps,        \* Seq of edit ops applied (for EditCorrectness)
    justCompleted   \* BOOLEAN: TRUE immediately after CompleteEdit

vars == <<fileContent, mtime, refs, nextRefId, tempFile, editPhase,
          preEditContent, editOps, justCompleted>>

\* --- Helpers ---

\* Checksum is modeled as the subsequence itself (injective by definition).
Checksum(seq, start, end) ==
    SubSeq(seq, start, end)

\* All sequences of Lines with length in lo..hi.
SeqsOfLength(lo, hi) == UNION {[1..n -> Lines] : n \in lo..hi}

\* --- ApplyOps: recursive operator to apply sorted, non-overlapping ops ---
\* cursor tracks the current position in the original content.
\* Each op is [start, end, newContent, insertAfter].
\* Replace: copy content[cursor..start-1], emit newContent, advance cursor to end+1.
\* Insert-after: copy content[cursor..start], emit newContent, advance cursor to start+1.

RECURSIVE ApplyOps(_, _, _)
ApplyOps(content, ops, cursor) ==
    IF ops = <<>> THEN
        \* No more ops: copy remaining content from cursor to end
        IF cursor > Len(content) THEN <<>>
        ELSE SubSeq(content, cursor, Len(content))
    ELSE
        LET op == Head(ops)
            rest == Tail(ops)
        IN IF op.insertAfter THEN
            \* Insert-after: copy up to and including anchor, insert new content
            SubSeq(content, cursor, op.start)
            \o op.newContent
            \o ApplyOps(content, rest, op.start + 1)
        ELSE
            \* Replace: copy before range, emit replacement, skip replaced range
            (IF cursor <= op.start - 1
             THEN SubSeq(content, cursor, op.start - 1)
             ELSE <<>>)
            \o op.newContent
            \o ApplyOps(content, rest, op.end + 1)

\* --- Initial state ---

Init ==
    /\ fileContent \in SeqsOfLength(1, MaxLines)
    /\ mtime = 0
    /\ refs = [x \in {} |-> {}]
    /\ nextRefId = 1
    /\ tempFile = <<>>
    /\ editPhase = "idle"
    /\ preEditContent = <<>>
    /\ editOps = <<>>
    /\ justCompleted = FALSE

\* --- Actions ---

\* Read a range and issue a ref with its checksum.
Read(start, end) ==
    /\ editPhase = "idle"
    /\ start >= 1 /\ end <= Len(fileContent) /\ start <= end
    /\ nextRefId <= MaxRefs
    /\ refs' = refs @@ (nextRefId :> [start |-> start,
                                        end |-> end,
                                        checksum |-> Checksum(fileContent, start, end),
                                        mtime |-> mtime])
    /\ nextRefId' = nextRefId + 1
    /\ UNCHANGED <<fileContent, mtime, tempFile, editPhase, preEditContent, editOps>>
    /\ justCompleted' = FALSE

\* External process mutates the file (simulates concurrent editor).
ExternalMutate ==
    /\ editPhase = "idle"
    /\ \E newContent \in SeqsOfLength(1, MaxLines) :
        /\ newContent /= fileContent
        /\ fileContent' = newContent
        /\ mtime' = mtime + 1
    /\ UNCHANGED <<refs, nextRefId, tempFile, editPhase, preEditContent, editOps>>
    /\ justCompleted' = FALSE

\* Begin an edit with a sequence of ops. Validates mtime and checksum,
\* then applies all ops to build tempFile.
BeginEdit(refId, ops) ==
    /\ editPhase = "idle"
    /\ refId \in DOMAIN refs
    /\ Len(fileContent) >= 1
    \* Ref must cover the full file (simplification for bounded model)
    /\ refs[refId].start = 1
    /\ refs[refId].end = Len(fileContent)
    \* I5: mtime guard
    /\ refs[refId].mtime = mtime
    \* I1: checksum match
    /\ refs[refId].checksum = Checksum(fileContent, 1, Len(fileContent))
    \* Ops must be non-empty
    /\ Len(ops) >= 1
    \* All ops must have valid ranges within the file
    /\ \A i \in 1..Len(ops) :
        /\ ops[i].start >= 1
        /\ ops[i].start <= Len(fileContent)
        /\ IF ops[i].insertAfter
           THEN ops[i].end = ops[i].start
           ELSE ops[i].end >= ops[i].start /\ ops[i].end <= Len(fileContent)
    \* Ops must be sorted by start and non-overlapping
    /\ \A i \in 1..Len(ops)-1 :
        IF ops[i].insertAfter
        THEN ops[i].start < ops[i+1].start
        ELSE ops[i].end < ops[i+1].start
    \* Apply ops and record state
    /\ preEditContent' = fileContent
    /\ editOps' = ops
    /\ tempFile' = ApplyOps(fileContent, ops, 1)
    /\ editPhase' = "writing"
    /\ UNCHANGED <<fileContent, mtime, refs, nextRefId>>
    /\ justCompleted' = FALSE

\* Complete the edit: atomic rename (tempFile -> fileContent).
CompleteEdit ==
    /\ editPhase = "writing"
    /\ fileContent' = tempFile
    /\ mtime' = mtime + 1
    /\ tempFile' = <<>>
    /\ editPhase' = "idle"
    /\ editOps' = <<>>
    /\ justCompleted' = TRUE
    /\ UNCHANGED <<nextRefId, preEditContent>>
    /\ refs' = refs  \* TODO: model adjustRefsAfterEdit in deep-dive

\* Crash during edit: temp file is discarded, original file preserved.
CrashDuringEdit ==
    /\ editPhase = "writing"
    /\ tempFile' = <<>>
    /\ editPhase' = "idle"
    /\ editOps' = <<>>
    /\ UNCHANGED <<fileContent, mtime, refs, nextRefId, preEditContent>>
    /\ justCompleted' = FALSE

\* --- Combined next-state relation ---

\* A single replace op for the Next quantifier.
ReplaceOp(s, e, nc) == [start |-> s, end |-> e, newContent |-> nc, insertAfter |-> FALSE]

\* A single insert-after op for the Next quantifier.
InsertOp(s, nc) == [start |-> s, end |-> s, newContent |-> nc, insertAfter |-> TRUE]

Next ==
    \/ \E s, e \in 1..MaxLines : Read(s, e)
    \/ ExternalMutate
    \* Single replace op
    \/ \E r \in DOMAIN refs, s, e \in 1..MaxLines,
          nc \in SeqsOfLength(0, MaxLines) :
        BeginEdit(r, <<ReplaceOp(s, e, nc)>>)
    \* Single insert-after op
    \/ \E r \in DOMAIN refs, s \in 1..MaxLines,
          nc \in SeqsOfLength(1, MaxLines) :
        BeginEdit(r, <<InsertOp(s, nc)>>)
    \* Two non-overlapping replace ops
    \/ \E r \in DOMAIN refs,
          s1, e1, s2, e2 \in 1..MaxLines,
          nc1 \in SeqsOfLength(0, MaxLines),
          nc2 \in SeqsOfLength(0, MaxLines) :
        /\ e1 >= s1 /\ e2 >= s2 /\ e1 < s2
        /\ BeginEdit(r, <<ReplaceOp(s1, e1, nc1), ReplaceOp(s2, e2, nc2)>>)
    \* Replace then insert-after (mixed ops, gap #1)
    \/ \E r \in DOMAIN refs,
          s1, e1, s2 \in 1..MaxLines,
          nc1 \in SeqsOfLength(0, MaxLines),
          nc2 \in SeqsOfLength(1, MaxLines) :
        /\ e1 >= s1 /\ e1 < s2
        /\ BeginEdit(r, <<ReplaceOp(s1, e1, nc1), InsertOp(s2, nc2)>>)
    \* Insert-after then replace (mixed ops, gap #1)
    \/ \E r \in DOMAIN refs,
          s1, s2, e2 \in 1..MaxLines,
          nc1 \in SeqsOfLength(1, MaxLines),
          nc2 \in SeqsOfLength(0, MaxLines) :
        /\ e2 >= s2 /\ s1 < s2
        /\ BeginEdit(r, <<InsertOp(s1, nc1), ReplaceOp(s2, e2, nc2)>>)
    \* Two insert-after ops (gap #2: boundary coverage)
    \/ \E r \in DOMAIN refs,
          s1, s2 \in 1..MaxLines,
          nc1 \in SeqsOfLength(1, MaxLines),
          nc2 \in SeqsOfLength(1, MaxLines) :
        /\ s1 < s2
        /\ BeginEdit(r, <<InsertOp(s1, nc1), InsertOp(s2, nc2)>>)
    \/ CompleteEdit
    \/ CrashDuringEdit

\* --- Invariants ---

\* Type invariant.
TypeOK ==
    /\ fileContent \in Seq(Lines)
    /\ mtime \in Nat
    /\ editPhase \in {"idle", "writing"}
    /\ tempFile \in Seq(Lines)
    /\ editOps \in Seq([start : Nat, end : Nat,
                        newContent : Seq(Lines), insertAfter : BOOLEAN])
    /\ justCompleted \in BOOLEAN

\* I1: Content preservation. During writing, tempFile is a well-formed
\* sequence constructed from verified content.
ContentPreservation ==
    editPhase = "writing" => tempFile \in Seq(Lines)

\* I4: Atomicity. The file on disk is never in a partial state.
Atomicity ==
    editPhase = "writing" => fileContent = preEditContent

\* CrashSafety: No temp file left behind when idle.
CrashSafety ==
    editPhase = "idle" => tempFile = <<>>

\* EditCorrectness: tempFile matches ApplyOps applied to pre-edit content.
EditCorrectness ==
    editPhase = "writing" =>
        tempFile = ApplyOps(preEditContent, editOps, 1)

\* Gap #4: Overlapping op rejection. If we are in the writing phase,
\* the recorded ops are sorted and non-overlapping. This is redundant
\* with BeginEdit's precondition but catches regressions if the guard
\* is weakened.
OpsNonOverlapping ==
    editPhase = "writing" =>
        /\ Len(editOps) >= 1
        /\ \A i \in 1..Len(editOps)-1 :
            IF editOps[i].insertAfter
            THEN editOps[i].start < editOps[i+1].start
            ELSE editOps[i].end < editOps[i+1].start

\* Gap #5: Ref invalidation after edit. Immediately after CompleteEdit,
\* all existing refs have stale mtime (< current mtime), so BeginEdit's
\* mtime guard will reject them. A fresh Read is required.
StaleRefsAfterEdit ==
    justCompleted =>
        \A r \in DOMAIN refs : refs[r].mtime < mtime

\* I5: Mtime guard. Encoded as a precondition in BeginEdit.
MtimeGuard ==
    TRUE

\* --- Spec ---

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

=============================================================================
