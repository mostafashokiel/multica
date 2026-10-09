"use client";

import { Flag, Plus, Trash2, Unlink, X } from "lucide-react";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions, memberListOptions, skillListOptions } from "@multica/core/workspace/queries";
import {
  STAGE_HANDLES,
  handleTarget,
  type EditRefusal,
  type Handle,
  type MetadataEdit,
  type Stage,
  type StageEdit,
  type StageType,
  type WorkflowDefinition,
} from "@multica/core/workflows";
import { Button } from "@multica/ui/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@multica/ui/components/ui/field";
import { Input } from "@multica/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";

type TFn = ReturnType<typeof useT<"workflows">>["t"];

const NONE = "__none__";

function typeLabel(t: TFn, type: StageType): string {
  switch (type) {
    case "agent":
      return t(($) => $.designer.type.agent);
    case "human_gate":
      return t(($) => $.designer.type.human_gate);
    case "condition":
      return t(($) => $.designer.type.condition);
    case "end":
      return t(($) => $.designer.type.end);
  }
}

function refusalText(t: TFn, refusal: EditRefusal): string {
  switch (refusal.reason) {
    case "empty":
      return t(($) => $.properties.refusal.empty);
    case "taken":
      return t(($) => $.properties.refusal.taken, { name: refusal.name });
    case "reserved":
      return t(($) => $.properties.refusal.reserved, { name: refusal.name });
  }
}

// ---- small fields ---------------------------------------------------------------------------------

/** Applies on blur or Enter, because renaming rewrites every reference to it. */
function RenameField({
  id,
  label,
  hint,
  value,
  mono,
  onRename,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  mono?: boolean;
  /** Returns why the new value was refused, or null when it was applied. */
  onRename: (next: string) => EditRefusal | null;
}) {
  const { t } = useT("workflows");
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [error, setError] = useState<EditRefusal | null>(null);
  // The committed value changed from outside (undo, another selection): the text follows it.
  if (value !== seen) {
    setSeen(value);
    setText(value);
    setError(null);
  }
  const apply = () => {
    if (text === value) return;
    const refusal = onRename(text);
    setError(refusal);
    if (refusal !== null) setText(value);
  };
  return (
    <Field data-invalid={error !== null || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        className={mono ? "font-mono" : undefined}
        value={text}
        aria-invalid={error !== null || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {hint !== undefined && error === null ? <FieldDescription>{hint}</FieldDescription> : null}
      {error !== null ? <FieldError>{refusalText(t, error)}</FieldError> : null}
    </Field>
  );
}

function PositiveNumber({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        min={1}
        step={1}
        value={value ?? ""}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          onChange(Number.isInteger(n) && n > 0 ? n : undefined);
        }}
      />
      {hint !== undefined ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** Skills as chips: type a name (the workspace's skills are suggested) and press Enter. */
function SkillsField({ skills, suggestions, onChange }: { skills: string[]; suggestions: string[]; onChange: (next: string[]) => void }) {
  const { t } = useT("workflows");
  const listId = useId();
  const [text, setText] = useState("");
  const add = () => {
    const name = text.trim();
    setText("");
    if (name !== "" && !skills.includes(name)) onChange([...skills, name]);
  };
  return (
    <Field>
      <FieldLabel htmlFor={`${listId}-input`}>{t(($) => $.properties.skills)}</FieldLabel>
      {skills.length > 0 ? (
        <ul className="flex flex-wrap gap-1">
          {skills.map((skill) => (
            <li key={skill} className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-caption">
              <span className="font-mono">{skill}</span>
              <button
                type="button"
                aria-label={t(($) => $.properties.skills_remove, { name: skill })}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onChange(skills.filter((s) => s !== skill))}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        id={`${listId}-input`}
        list={listId}
        placeholder={t(($) => $.properties.skills_add)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
      <datalist id={listId}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </Field>
  );
}

/** Workspace names for the pickers; typing anything else is always allowed. */
function useSuggestions() {
  const wsId = useWorkspaceId();
  const agents = useQuery(agentListOptions(wsId));
  const skills = useQuery(skillListOptions(wsId));
  const members = useQuery(memberListOptions(wsId));
  return {
    agents: (agents.data ?? []).filter((a) => !a.archived_at).map((a) => a.name),
    // When the workspace's agents cannot be read, the field falls back to typed text.
    agentsFailed: agents.isError,
    skills: (skills.data ?? []).map((s) => s.name),
    members: members.data ?? [],
  };
}

// ---- the selected stage ---------------------------------------------------------------------------

export function StageProperties({
  definition,
  stage,
  onEdit,
  onRename,
  onSetStart,
  onDisconnect,
  onDelete,
  onGroupMembers,
}: {
  definition: WorkflowDefinition;
  stage: Stage;
  onEdit: (edit: StageEdit, mergeKey: string) => void;
  onRename: (next: string) => EditRefusal | null;
  onGroupMembers: (group: string, members: string[]) => void;
  onSetStart: () => void;
  onDisconnect: (handle: Handle) => void;
  onDelete: () => void;
}) {
  const { t } = useT("workflows");
  const suggestions = useSuggestions();
  const isStart = definition.start === stage.id;
  const edit = (partial: StageEdit, field: string) => onEdit(partial, `${stage.id}:${field}`);
  const outputs = STAGE_HANDLES[stage.type];
  const edgeName = (handle: Handle) => {
    switch (handle) {
      case "next":
        return t(($) => $.editor.edge_next);
      case "approve":
        return t(($) => $.designer.edge.approve);
      case "reject":
        return t(($) => $.designer.edge.reject);
      case "then":
        return t(($) => $.designer.edge.then);
      case "else":
        return t(($) => $.designer.edge.else);
    }
  };
  const groups = Object.keys(definition.approvers);
  const undefinedGroup = stage.type === "human_gate" && stage.approvers !== "" && !groups.includes(stage.approvers) ? stage.approvers : null;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-body font-medium">{t(($) => $.properties.stage_title, { type: typeLabel(t, stage.type) })}</h2>

      <RenameField id="stage-id" label={t(($) => $.properties.id)} hint={t(($) => $.properties.id_hint)} value={stage.id} mono onRename={onRename} />
      <Field>
        <FieldLabel htmlFor="stage-name">{t(($) => $.properties.name)}</FieldLabel>
        <Input id="stage-name" value={stage.name ?? ""} onChange={(e) => edit({ name: e.target.value }, "name")} />
        <FieldDescription>{t(($) => $.properties.name_hint)}</FieldDescription>
      </Field>

      {stage.type === "agent" ? (
        <>
          <Field>
            <FieldLabel htmlFor="stage-agent">{t(($) => $.properties.agent)}</FieldLabel>
            {suggestions.agentsFailed ? (
              <Input id="stage-agent" className="font-mono" value={stage.agent} onChange={(e) => edit({ agent: e.target.value }, "agent")} />
            ) : (
              <Select
                items={[
                  { value: NONE, label: t(($) => $.properties.none) },
                  ...suggestions.agents.map((name) => ({ value: name, label: name })),
                  ...(stage.agent === "" || suggestions.agents.includes(stage.agent)
                    ? []
                    : [{ value: stage.agent, label: t(($) => $.properties.agent_unregistered, { name: stage.agent }) }]),
                ]}
                value={stage.agent === "" ? NONE : stage.agent}
                onValueChange={(next) => edit({ agent: next === null || next === NONE ? "" : next }, "agent")}
              >
                <SelectTrigger id="stage-agent" className="w-full font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t(($) => $.properties.none)}</SelectItem>
                  {suggestions.agents.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                  {stage.agent !== "" && !suggestions.agents.includes(stage.agent) ? (
                    <SelectItem value={stage.agent}>{t(($) => $.properties.agent_unregistered, { name: stage.agent })}</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            )}
            <FieldDescription>{t(($) => $.properties.agent_hint)}</FieldDescription>
          </Field>
          <SkillsField skills={stage.skills ?? []} suggestions={suggestions.skills} onChange={(next) => edit({ skills: next }, "skills")} />
          <Field>
            <FieldLabel htmlFor="stage-output">{t(($) => $.properties.expected_output)}</FieldLabel>
            <Textarea id="stage-output" rows={3} value={stage.expected_output ?? ""} onChange={(e) => edit({ expected_output: e.target.value }, "expected_output")} />
            <FieldDescription>{t(($) => $.properties.expected_output_hint)}</FieldDescription>
          </Field>
        </>
      ) : null}

      {stage.type === "human_gate" ? (
        <>
          <Field>
            <FieldLabel htmlFor="stage-approvers">{t(($) => $.properties.approver_group)}</FieldLabel>
            <Select
              items={[
                { value: NONE, label: t(($) => $.properties.none) },
                ...groups.map((g) => ({ value: g, label: g })),
                ...(undefinedGroup === null ? [] : [{ value: undefinedGroup, label: t(($) => $.properties.group_undefined, { name: undefinedGroup }) }]),
              ]}
              value={stage.approvers === "" ? NONE : stage.approvers}
              onValueChange={(next) => edit({ approvers: next === null || next === NONE ? "" : next }, "approvers")}
            >
              <SelectTrigger id="stage-approvers" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t(($) => $.properties.none)}</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
                {undefinedGroup !== null ? (
                  <SelectItem value={undefinedGroup}>{t(($) => $.properties.group_undefined, { name: undefinedGroup })}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            <FieldDescription>{t(($) => $.properties.approver_group_hint)}</FieldDescription>
          </Field>
          {stage.approvers !== "" && definition.approvers[stage.approvers] !== undefined ? (
            <div className="rounded-lg border p-3">
              <GroupMembers
                name={stage.approvers}
                members={definition.approvers[stage.approvers] ?? []}
                workspaceMembers={suggestions.members}
                onMembers={(next) => onGroupMembers(stage.approvers, next)}
              />
            </div>
          ) : null}
          <PositiveNumber
            id="stage-rework"
            label={t(($) => $.properties.max_rework)}
            hint={t(($) => $.properties.max_rework_hint)}
            value={stage.max_rework}
            onChange={(max_rework) => edit({ max_rework }, "max_rework")}
          />
          <PositiveNumber
            id="stage-escalate"
            label={t(($) => $.properties.escalate)}
            value={stage.escalate_after_hours}
            onChange={(escalate_after_hours) => edit({ escalate_after_hours }, "escalate_after_hours")}
          />
        </>
      ) : null}

      {stage.type === "condition" ? (
        <Field>
          <FieldLabel htmlFor="stage-when">{t(($) => $.properties.when)}</FieldLabel>
          <Input id="stage-when" className="font-mono" value={stage.when} onChange={(e) => edit({ when: e.target.value }, "when")} />
          <FieldDescription>{t(($) => $.properties.when_hint)}</FieldDescription>
        </Field>
      ) : null}

      {outputs.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label={t(($) => $.editor.connections)}>
          <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{t(($) => $.editor.connections)}</h3>
          <ul className="flex flex-col gap-1.5">
            {outputs.map((handle) => {
              const target = handleTarget(stage, handle);
              return (
                <li key={handle} className="flex items-center gap-2 text-body">
                  <span className="w-16 shrink-0 text-muted-foreground">{edgeName(handle)}</span>
                  {target === "" ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{t(($) => $.editor.not_connected)}</span>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate font-mono">{target}</span>
                      <Button size="icon-xs" variant="ghost" aria-label={t(($) => $.editor.disconnect, { name: edgeName(handle) })} onClick={() => onDisconnect(handle)}>
                        <Unlink aria-hidden="true" className="size-3.5" />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button size="sm" variant="outline" disabled={isStart} onClick={onSetStart}>
          <Flag aria-hidden="true" className="size-3.5" />
          {isStart ? t(($) => $.editor.is_start) : t(($) => $.editor.set_start)}
        </Button>
        <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 aria-hidden="true" className="size-3.5" />
          {t(($) => $.editor.delete_stage)}
        </Button>
      </div>
    </div>
  );
}

// ---- the workflow as a whole ----------------------------------------------------------------------

export function WorkflowSettings({
  definition,
  idLocked,
  onMetadata,
  onStart,
  onGroupMembers,
  onGroupRename,
  onGroupRemove,
  onGroupAdd,
}: {
  definition: WorkflowDefinition;
  /** The id is the workflow's key; it cannot change once the first version is saved. */
  idLocked: boolean;
  onMetadata: (edit: MetadataEdit, mergeKey: string) => void;
  onStart: (id: string) => void;
  onGroupMembers: (name: string, members: string[]) => void;
  onGroupRename: (from: string, to: string) => EditRefusal | null;
  onGroupRemove: (name: string) => void;
  onGroupAdd: (name: string) => EditRefusal | null;
}) {
  const { t } = useT("workflows");
  const suggestions = useSuggestions();
  const agentListId = useId();
  const [newGroup, setNewGroup] = useState("");
  const [groupError, setGroupError] = useState<EditRefusal | null>(null);
  const meta = (edit: MetadataEdit, field: string) => onMetadata(edit, `meta:${field}`);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-body font-medium">{t(($) => $.editor.settings.title)}</h2>
      <Field>
        <FieldLabel htmlFor="wf-id">{t(($) => $.editor.settings.id)}</FieldLabel>
        <Input id="wf-id" className="font-mono" value={definition.metadata.id} disabled={idLocked} onChange={(e) => meta({ id: e.target.value }, "id")} />
        <FieldDescription>{idLocked ? t(($) => $.editor.settings.id_locked) : t(($) => $.editor.settings.id_hint)}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="wf-description">{t(($) => $.editor.settings.description)}</FieldLabel>
        <Textarea id="wf-description" rows={3} value={definition.metadata.description ?? ""} onChange={(e) => meta({ description: e.target.value }, "description")} />
        <FieldDescription>{t(($) => $.editor.settings.description_hint)}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="wf-owner">{t(($) => $.editor.settings.owner)}</FieldLabel>
        <Input id="wf-owner" value={definition.metadata.owner ?? ""} onChange={(e) => meta({ owner: e.target.value }, "owner")} />
        <FieldDescription>{t(($) => $.editor.settings.owner_hint)}</FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="wf-start">{t(($) => $.properties.start_stage)}</FieldLabel>
        <Select
          items={[{ value: NONE, label: t(($) => $.properties.none) }, ...definition.stages.map((s) => ({ value: s.id, label: s.name ?? s.id }))]}
          value={definition.start === "" ? NONE : definition.start}
          onValueChange={(next) => onStart(next === null || next === NONE ? "" : next)}
        >
          <SelectTrigger id="wf-start" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t(($) => $.properties.none)}</SelectItem>
            {definition.stages.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name ?? s.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor="wf-squad">{t(($) => $.properties.squad_name)}</FieldLabel>
        <Input id="wf-squad" value={definition.target?.squad.name ?? ""} onChange={(e) => meta({ squadName: e.target.value }, "squadName")} />
        <FieldDescription>{t(($) => $.properties.squad_hint)}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="wf-leader">{t(($) => $.properties.squad_leader)}</FieldLabel>
        <Input id="wf-leader" list={agentListId} className="font-mono" value={definition.target?.squad.leader ?? ""} onChange={(e) => meta({ squadLeader: e.target.value }, "squadLeader")} />
        <datalist id={agentListId}>
          {suggestions.agents.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <section className="flex flex-col gap-3" aria-label={t(($) => $.properties.groups)}>
        <div>
          <h3 className="text-body font-medium">{t(($) => $.properties.groups)}</h3>
          <p className="text-caption text-muted-foreground">{t(($) => $.properties.groups_hint)}</p>
        </div>
        {Object.entries(definition.approvers).map(([name, members]) => (
          <GroupEditor
            key={name}
            name={name}
            members={members}
            workspaceMembers={suggestions.members}
            onMembers={(next) => onGroupMembers(name, next)}
            onRename={(to) => onGroupRename(name, to)}
            onRemove={() => onGroupRemove(name)}
          />
        ))}
        <Field data-invalid={groupError !== null || undefined}>
          <FieldLabel htmlFor="wf-new-group">{t(($) => $.properties.group_new)}</FieldLabel>
          <div className="flex gap-2">
            <Input id="wf-new-group" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const refusal = onGroupAdd(newGroup.trim());
                setGroupError(refusal);
                if (refusal === null) setNewGroup("");
              }}
            >
              <Plus aria-hidden="true" className="size-3.5" />
              {t(($) => $.properties.group_add)}
            </Button>
          </div>
          {groupError !== null ? <FieldError>{refusalText(t, groupError)}</FieldError> : null}
        </Field>
      </section>
    </div>
  );
}

/** The people of one approver group: who they are, whether each is registered, and a picker for more. */
function GroupMembers({
  name,
  members,
  workspaceMembers,
  onMembers,
}: {
  name: string;
  members: string[];
  workspaceMembers: { user_id: string; name: string; email: string }[];
  onMembers: (members: string[]) => void;
}) {
  const { t } = useT("workflows");
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  // Everyone registered who is not in the group yet; the filter narrows the list.
  const candidates = workspaceMembers.filter(
    (m) => !members.includes(`user:${m.user_id}`) && (needle === "" || `${m.name} ${m.email}`.toLowerCase().includes(needle)),
  );
  const nameOf = (entry: string): string | undefined => workspaceMembers.find((m) => `user:${m.user_id}` === entry)?.name;
  const add = (m: { user_id: string }) => {
    onMembers([...members, `user:${m.user_id}`]);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-caption text-muted-foreground">{t(($) => $.properties.group_members, { name })}</span>
        {members.length === 0 ? (
          <p className="text-caption text-muted-foreground">{t(($) => $.properties.group_empty)}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {members.map((entry) => {
              const person = nameOf(entry);
              return (
                <li key={entry} className="flex items-center gap-2 text-body">
                  <span className="min-w-0 flex-1 break-words">
                    {person !== undefined ? (
                      person
                    ) : (
                      <>
                        <code className="text-caption text-muted-foreground">{entry}</code>
                        <span className="block text-caption text-warning">{t(($) => $.properties.group_unregistered)}</span>
                      </>
                    )}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t(($) => $.properties.group_remove_member, { name: person ?? entry })}
                    onClick={() => onMembers(members.filter((m) => m !== entry))}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Button size="sm" variant="outline" className="self-start" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>
        <Plus aria-hidden="true" className="size-3.5" />
        {t(($) => $.properties.group_add_person)}
      </Button>
      {picking ? (
        <div className="flex flex-col gap-1.5 rounded-lg border p-2">
          <Input
            aria-label={t(($) => $.properties.group_filter)}
            placeholder={t(($) => $.properties.group_filter)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {candidates.length === 0 ? (
            <p className="px-1 text-caption text-muted-foreground">
              {workspaceMembers.length === 0 || needle !== ""
                ? t(($) => $.properties.group_no_match)
                : t(($) => $.properties.group_all_added)}
            </p>
          ) : (
            <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
              {candidates.map((m) => (
                <li key={m.user_id}>
                  <Button size="sm" variant="ghost" className="h-auto w-full justify-start py-1" onClick={() => add(m)}>
                    <span className="flex min-w-0 flex-col items-start text-left">
                      <span className="truncate">{t(($) => $.properties.group_add_member, { name: m.name })}</span>
                      <span className="truncate text-caption text-muted-foreground">{m.email}</span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GroupEditor({
  name,
  members,
  workspaceMembers,
  onMembers,
  onRename,
  onRemove,
}: {
  name: string;
  members: string[];
  workspaceMembers: { user_id: string; name: string; email: string }[];
  onMembers: (members: string[]) => void;
  onRename: (to: string) => EditRefusal | null;
  onRemove: () => void;
}) {
  const { t } = useT("workflows");
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <RenameField id={`group-${name}`} label={t(($) => $.properties.group_name)} value={name} mono onRename={onRename} />
      <GroupMembers name={name} members={members} workspaceMembers={workspaceMembers} onMembers={onMembers} />
      <Button size="sm" variant="ghost" className="self-start text-destructive hover:text-destructive" onClick={onRemove}>
        <Trash2 aria-hidden="true" className="size-3.5" />
        {t(($) => $.properties.group_remove)}
      </Button>
    </div>
  );
}
