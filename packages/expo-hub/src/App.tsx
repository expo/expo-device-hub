import Dashboard from './Dashboard';

export default function App() {
  // The single Hub screen lives in a DOM component (`'use dom'`) so it is
  // authored with web primitives instead of react-native-web.
  return <Dashboard dom={{ scrollEnabled: false }} />;
}
