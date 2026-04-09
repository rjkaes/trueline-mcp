------------------------------- MODULE MC -----------------------------------
EXTENDS EditProtocol

MCMaxLines == 2
MCMaxRefs == 2
MCMaxOps == 2
MCLines == {"a", "b"}

MCInit == Init
MCNext == Next

\* Next without external mutation: tests core protocol in isolation.
MCNextNoMutate ==
    \* Single replace op
    \/ \E s, e \in 1..MCMaxLines : Read(s, e)
    \/ \E r \in DOMAIN refs, s, e \in 1..MCMaxLines,
          nc \in SeqsOfLength(0, MCMaxLines) :
        BeginEdit(r, <<ReplaceOp(s, e, nc)>>)
    \* Single insert-after op
    \/ \E r \in DOMAIN refs, s \in 1..MCMaxLines,
          nc \in SeqsOfLength(1, MCMaxLines) :
        BeginEdit(r, <<InsertOp(s, nc)>>)
    \* Two non-overlapping replace ops
    \/ \E r \in DOMAIN refs,
          s1, e1, s2, e2 \in 1..MCMaxLines,
          nc1 \in SeqsOfLength(0, MCMaxLines),
          nc2 \in SeqsOfLength(0, MCMaxLines) :
        /\ e1 >= s1 /\ e2 >= s2 /\ e1 < s2
        /\ BeginEdit(r, <<ReplaceOp(s1, e1, nc1), ReplaceOp(s2, e2, nc2)>>)
    \* Replace then insert-after
    \/ \E r \in DOMAIN refs,
          s1, e1, s2 \in 1..MCMaxLines,
          nc1 \in SeqsOfLength(0, MCMaxLines),
          nc2 \in SeqsOfLength(1, MCMaxLines) :
        /\ e1 >= s1 /\ e1 < s2
        /\ BeginEdit(r, <<ReplaceOp(s1, e1, nc1), InsertOp(s2, nc2)>>)
    \* Insert-after then replace
    \/ \E r \in DOMAIN refs,
          s1, s2, e2 \in 1..MCMaxLines,
          nc1 \in SeqsOfLength(1, MCMaxLines),
          nc2 \in SeqsOfLength(0, MCMaxLines) :
        /\ e2 >= s2 /\ s1 < s2
        /\ BeginEdit(r, <<InsertOp(s1, nc1), ReplaceOp(s2, e2, nc2)>>)
    \* Two insert-after ops
    \/ \E r \in DOMAIN refs,
          s1, s2 \in 1..MCMaxLines,
          nc1 \in SeqsOfLength(1, MCMaxLines),
          nc2 \in SeqsOfLength(1, MCMaxLines) :
        /\ s1 < s2
        /\ BeginEdit(r, <<InsertOp(s1, nc1), InsertOp(s2, nc2)>>)
    \/ CompleteEdit
    \/ CrashDuringEdit
=============================================================================
