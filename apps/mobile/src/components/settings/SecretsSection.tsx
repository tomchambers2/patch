// Settings → Keys → Secrets: the key-value store the host injects into
// chats. Editable from any surface: add a key, replace a value (write-only;
// existing values masked until the row is tapped), delete. Validated locally
// before the round-trip; a failed read or write is said.

import React from 'react';
import { Alert, View } from 'react-native';
import { api } from '../../api/rest';
import { removeSecret, upsertSecret, validateSecret } from '../../lib/secretsEditor';
import { radii, space, useTheme } from '../../lib/theme';
import { SettingsSection } from '../SettingsSection';
import { NoticeRow } from './HostSwitcher';
import { ButtonRow, ErrorLine, Field, Row, SettingsButton } from './ui';

type Secret = { key: string; value: string };

export function SecretsSection(): React.ReactElement {
  const colors = useTheme();
  const [secrets, setSecrets] = React.useState<Secret[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});
  const [adding, setAdding] = React.useState(false);
  const [newKey, setNewKey] = React.useState('');
  const [newValue, setNewValue] = React.useState('');
  const [editingKey, setEditingKey] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    setLoadError(null);
    void api
      .listSecrets()
      .then((r) => setSecrets(r.secrets))
      .catch((e: Error) => setLoadError(e.message));
  }, []);
  React.useEffect(load, [load]);

  const addSecret = async (): Promise<void> => {
    const check = validateSecret(newKey, newValue, {
      existingKeys: (secrets ?? []).map((s) => s.key),
      isNew: true,
    });
    if (!check.ok) {
      Alert.alert('Invalid secret', check.message);
      return;
    }
    const key = newKey.trim();
    setBusy(true);
    try {
      await api.setSecret(key, newValue);
      setSecrets((prev) => upsertSecret(prev ?? [], key, newValue));
      setNewKey('');
      setNewValue('');
      setAdding(false);
    } catch (e) {
      Alert.alert('Failed to save secret', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (key: string): Promise<void> => {
    const check = validateSecret(key, editValue, { isNew: false });
    if (!check.ok) {
      Alert.alert('Invalid value', check.message);
      return;
    }
    setBusy(true);
    try {
      await api.setSecret(key, editValue);
      setSecrets((prev) => upsertSecret(prev ?? [], key, editValue));
      setEditingKey(null);
      setEditValue('');
    } catch (e) {
      Alert.alert('Failed to update secret', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (key: string): void => {
    Alert.alert('Delete secret?', `Remove ${key}? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          api
            .deleteSecret(key)
            .then(() => {
              setSecrets((prev) => removeSecret(prev ?? [], key));
              setEditingKey(null);
            })
            .catch((e: Error) => Alert.alert('Failed to delete secret', e.message))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <SettingsSection
      title="Secrets"
      testID="settings-secrets"
      footer={
        <View>
          <SettingsButton
            testID="secret-add-open"
            label="Add secret"
            variant="quiet"
            disabled={secrets === null}
            onPress={() => setAdding((v) => !v)}
          />
          {adding ? (
            <View
              style={{
                marginTop: space.sm,
                padding: space.md,
                gap: space.sm,
                borderWidth: 1,
                borderColor: colors.lineSoft,
                borderRadius: radii.lg,
                backgroundColor: colors.paperRaised,
              }}
            >
              <Field
                testID="secret-new-key"
                accessibilityLabel="New secret key"
                value={newKey}
                onChangeText={setNewKey}
                placeholder="KEY_NAME"
                autoCapitalize="characters"
              />
              <Field
                testID="secret-new-value"
                accessibilityLabel="New secret value"
                value={newValue}
                onChangeText={setNewValue}
                placeholder="Value"
                secureTextEntry
              />
              <SettingsButton
                testID="secret-add"
                label="Add"
                disabled={busy}
                onPress={() => void addSecret()}
              />
            </View>
          ) : null}
        </View>
      }
    >
      {loadError ? (
        <View style={{ padding: space.md }}>
          <ErrorLine
            testID="secrets-error"
            message={`Couldn’t load secrets: ${loadError}`}
            onRetry={load}
          />
        </View>
      ) : secrets === null ? (
        <NoticeRow text="Loading…" />
      ) : secrets.length === 0 ? (
        <NoticeRow testID="secrets-empty" text="No secrets" />
      ) : (
        secrets.map((s) => (
          <Row
            key={s.key}
            testID={`secret-${s.key}`}
            title={s.key}
            subtitle={revealed[s.key] ? s.value : '••••••••'}
            accessibilityLabel={revealed[s.key] ? `Hide ${s.key}` : `Reveal ${s.key}`}
            onPress={() => setRevealed((r) => ({ ...r, [s.key]: !r[s.key] }))}
            right={
              editingKey === s.key ? null : (
                <SettingsButton
                  label="Edit"
                  variant="quiet"
                  accessibilityLabel={`Edit ${s.key}`}
                  onPress={() => {
                    setEditingKey(s.key);
                    setEditValue('');
                  }}
                />
              )
            }
          >
            {editingKey === s.key ? (
              <View style={{ marginTop: space.sm }}>
                <Field
                  accessibilityLabel={`New value for ${s.key}`}
                  value={editValue}
                  onChangeText={setEditValue}
                  placeholder="New value"
                  secureTextEntry
                />
                <ButtonRow>
                  <SettingsButton
                    label="Save"
                    accessibilityLabel={`Save ${s.key}`}
                    disabled={busy}
                    onPress={() => void saveEdit(s.key)}
                  />
                  <SettingsButton
                    label="Cancel"
                    variant="quiet"
                    onPress={() => {
                      setEditingKey(null);
                      setEditValue('');
                    }}
                  />
                  <SettingsButton
                    label="Delete"
                    variant="danger"
                    accessibilityLabel={`Delete ${s.key}`}
                    onPress={() => confirmDelete(s.key)}
                  />
                </ButtonRow>
              </View>
            ) : null}
          </Row>
        ))
      )}
    </SettingsSection>
  );
}
