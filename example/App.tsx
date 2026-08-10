import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

export default function App() {
  const [text, setText] = useState('');

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Expo Device Hub keyboard test</Text>
      <TextInput
        accessibilityLabel="Keyboard test input"
        testID="keyboard-test-input"
        value={text}
        onChangeText={setText}
        placeholder="Click in Device Hub, then type"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Text testID="keyboard-test-value" style={styles.value}>
        {text || 'Waiting for physical keyboard input…'}
      </Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  input: {
    width: '100%',
    maxWidth: 360,
    minHeight: 48,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#a1a1aa',
    borderRadius: 10,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  value: {
    minHeight: 24,
    color: '#3f3f46',
  },
});
