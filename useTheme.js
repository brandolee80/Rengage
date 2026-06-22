import { useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const palette = {
  dark: {
    bg: '#111318',
    card: '#181B23',
    card2: '#1F2330',
    border: 'rgba(255,255,255,0.06)',
    primary: '#E5453C',
    primaryDim: 'rgba(229,69,60,0.10)',
    accent: '#F59E0B',
    accentDim: 'rgba(245,158,11,0.10)',
    green: '#10B981',
    greenDim: 'rgba(16,185,129,0.08)',
    red: '#EF4444',
    redDim: 'rgba(239,68,68,0.08)',
    text: '#E2E8F0',
    textSecondary: 'rgba(255,255,255,0.55)',
    textMuted: 'rgba(255,255,255,0.3)',
    inputBg: 'rgba(255,255,255,0.04)',
    inputBorder: 'rgba(255,255,255,0.10)',
  },
  light: {
    bg: '#F5F5F7',
    card: '#FFFFFF',
    card2: '#F0F0F2',
    border: 'rgba(0,0,0,0.08)',
    primary: '#E5453C',
    primaryDim: 'rgba(229,69,60,0.08)',
    accent: '#D97706',
    accentDim: 'rgba(217,119,6,0.08)',
    green: '#059669',
    greenDim: 'rgba(5,150,105,0.08)',
    red: '#DC2626',
    redDim: 'rgba(220,38,38,0.06)',
    text: '#1A1A2E',
    textSecondary: 'rgba(0,0,0,0.55)',
    textMuted: 'rgba(0,0,0,0.3)',
    inputBg: 'rgba(0,0,0,0.03)',
    inputBorder: 'rgba(0,0,0,0.10)',
  },
};

export default function useTheme() {
  const [isDark, setIsDark] = useState(true);

  const toggle = useCallback(async () => {
    const next = !isDark;
    setIsDark(next);
    await AsyncStorage.setItem('rengage-theme', next ? 'dark' : 'light');
  }, [isDark]);

  const load = useCallback(async () => {
    const saved = await AsyncStorage.getItem('rengage-theme');
    if (saved === 'light') setIsDark(false);
  }, []);

  return {
    colors: isDark ? palette.dark : palette.light,
    isDark,
    toggle,
    load,
  };
}
