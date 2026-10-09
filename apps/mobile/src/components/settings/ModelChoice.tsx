// A model choice read from the account's home machine's catalogue, as a row —
// used by Settings → Agent (Model for new chats, the account's default) and by
// Settings → Manager (the Manager and Speakers threads' model).
//
// The catalogue is per host, so it is read from the account's home machine,
// the same rule every other host-scoped edit uses. With no home machine there
// is nothing to read a list FROM, and the row says that rather than offering a
// guessed list. The saved value is always kept as an option, so a catalogue
// that changed can never unpin it.

import React from 'react';
import { useModelCatalog } from '../../lib/models';
import { defaultDaemonId, usePresenceStore } from '../../stores/presenceStore';
import { OptionPicker } from '../OptionPicker';
import { ErrorLine, Row } from './ui';

export function ModelChoice({
  label,
  value,
  testID,
  onSelect,
}: {
  label: string;
  value: string;
  testID: string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const catalogueHost = usePresenceStore((s) => defaultDaemonId(s.hosts));
  const catalogue = useModelCatalog(catalogueHost);
  const ids = catalogue.models.map((m) => m.id);
  const extra = value && !ids.includes(value) ? [{ id: value, label: value }] : [];
  const options = [...extra, ...catalogue.models];
  const selectedLabel = options.find((o) => o.id === value)?.label ?? value;

  return (
    <Row
      title={label}
      subtitle={catalogueHost === null ? 'Make a host home to list models' : undefined}
      subtitleTestID={`${testID}-no-host`}
      right={
        <OptionPicker
          testID={testID}
          selectedId={value}
          selectedLabel={selectedLabel}
          options={options}
          onSelect={onSelect}
          emptyText="No models"
        />
      }
    >
      {catalogueHost !== null && catalogue.status === 'error' ? (
        <ErrorLine
          testID={`${testID}-error`}
          message={`Couldn’t load the model list: ${catalogue.error ?? 'unknown error'}`}
        />
      ) : null}
    </Row>
  );
}
