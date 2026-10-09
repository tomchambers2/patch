// Auth gate. If we have a credential, jump to the tab navigator. Otherwise
// show the pairing screen.

import React from 'react';
import { Redirect } from 'expo-router';
import { getRoute } from '../src/config';
import { loadCredential } from '../src/lib/credential';

export default function Index(): React.ReactElement {
  const hasCred = loadCredential() !== null && getRoute() !== null;
  return <Redirect href={hasCred ? '/(tabs)/chats' : '/pair'} />;
}
