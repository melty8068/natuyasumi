// App.js —— なつやすみ大作戦 (React Native / Expo)
// 準備:
//   npx create-expo-app natsuyasumi
//   npx expo install expo-notifications @react-native-async-storage/async-storage expo-haptics expo-device
//   scheduleData.js を同じフォルダに置いて、このファイルで App.js を置きかえる
//   npx expo start  → スマホの Expo Go アプリで QR を読む
// ※ 出発アラーム（10分前＋定時）は expo-notifications でOSに予約するので、
//    アプリを閉じていても鳴ります。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView, ScrollView, View, Text, TouchableOpacity, TextInput,
  StyleSheet, Platform, Alert, StatusBar,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import {
  CALENDAR, PNAME, PCOLOR, buildTimeline, toMin,
  MISSIONS, SHOP, STICKERS, PT_PER_STICKER,
} from './scheduleData';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

const THEME = {
  sun:  { c1:'#7EC8F5', c2:'#FFD84D', c3:'#FF8A65', bg:'#FDF6E6', memo:'#FFF8E1', memoTx:'#7A6A2F' },
  rain: { c1:'#8FB8E8', c2:'#A8E0E0', c3:'#B39DDB', bg:'#EFF3FA', memo:'#EAF1FB', memoTx:'#4A5C7A' },
};
const INK = '#3B3355', INK2 = '#6E6A8A', OK = '#4CD07D';
const FONT = Platform.select({ ios:'Hiragino Maru Gothic ProN', android:'sans-serif-medium' });

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mmdd = (iso) => iso.slice(5);
const DEFAULT_STATE = {
  kids: [
    { name:'秋', pt:0, used:0, stk:[] },
    { name:'晴', pt:0, used:0, stk:[] },
  ],
  done: {},      // { 'MM-DD': [[kid0 keys], [kid1 keys]] }
  kid: 0,
  weather: 'sun',
  manual: false,   // 手動で天気をえらんだか
  autoDay: '',     // 手動でえらんだ日
};

// 位置情報がとれないときの ばしょ（甲子園あたり）
const HOME = { lat:34.7217, lon:135.3617, name:'甲子園あたり' };

export default function App() {
  const [state, setState] = useState(DEFAULT_STATE);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('today');
  const [iso, setIso] = useState(() => {
    const t = isoOf(new Date());
    return CALENDAR[mmdd(t)] ? t : '2026-07-16';
  });
  const [now, setNow] = useState(new Date());
  const [wxMsg, setWxMsg] = useState('🛰️ きょうの天気を しらべています…');
  const scRef = useRef(null);
  const yRef = useRef({});

  const th = THEME[state.weather];
  const cal = CALENDAR[mmdd(iso)] || ['F', '日', ''];
  const [pattern, dow, memo] = cal;
  const timeline = useMemo(
    () => buildTimeline(pattern, state.weather, dow),
    [pattern, state.weather, dow]
  );
  const today = iso === isoOf(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const kid = state.kids[state.kid];
  const avail = kid.pt - kid.used;

  /* ---------- 読み込み・保存 ---------- */
  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem('natsu2026');
      if (raw) setState((s) => ({ ...s, ...JSON.parse(raw) }));
      setReady(true);
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('つうちを ONにしてね', 'しゅっぱつアラームを ならすには、せっていで つうちを きょかしてください。');
      }
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('alarm', {
          name: 'しゅっぱつアラーム',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 400],
          sound: 'default',
        });
      }
    })();
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (ready) AsyncStorage.setItem('natsu2026', JSON.stringify(state));
  }, [state, ready]);

  /* ---------- 出発アラームを OS に予約（今日ぶん・10分前＋定時） ---------- */
  useEffect(() => {
    if (!ready || !today) return;
    (async () => {
      await Notifications.cancelAllScheduledNotificationsAsync();
      for (const ev of timeline.filter((x) => x.go)) {
        const [h, m] = ev.time.split(':').map(Number);
        for (const [offset, title] of [[-10, 'あと10ぷんで しゅっぱつ！ ⏰'], [0, 'いま しゅっぱつ！ いってらっしゃい 👟']]) {
          const at = new Date(now);
          at.setHours(h, m + offset, 0, 0);
          if (at <= new Date()) continue;
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `${ev.icon} ${title}`,
              body: `${ev.title}${ev.note ? ' / ' + ev.note : ''}`,
              sound: 'default',
              vibrate: [0, 250, 250, 400],
            },
            trigger: Platform.OS === 'android' ? { date: at, channelId:'alarm' } : { date: at },
          });
        }
      }
    })();
  }, [ready, iso, state.weather, today, timeline.length]);

  /* ---------- 天気じどう判定（Open-Meteo・APIキーふよう） ---------- */
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    (async () => {
      if (state.manual && state.autoDay === mmdd(iso)) {
        setWxMsg('✋ 天気は 手動でえらんだままです（ボタンで かえられるよ）');
        return;
      }
      setWxMsg('🛰️ きょうの天気を しらべています…');
      let pos = HOME;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const p = await Location.getLastKnownPositionAsync() || await Location.getCurrentPositionAsync({});
          if (p) pos = { lat:p.coords.latitude, lon:p.coords.longitude, name:'いまいるばしょ' };
        }
      } catch (e) { /* HOME を使う */ }
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${pos.lat}&longitude=${pos.lon}`
          + `&daily=precipitation_probability_max&timezone=Asia%2FTokyo&start_date=${iso}&end_date=${iso}`;
        const j = await (await fetch(url)).json();
        const pop = j.daily.precipitation_probability_max[0];
        const w = pop >= 50 ? 'rain' : 'sun';
        if (!alive) return;
        setState((s) => ({ ...s, weather:w, manual:false, autoDay:mmdd(iso) }));
        setWxMsg(`🛰️ ${pos.name}・雨のかくりつ ${pop}% ➡ ${w === 'rain' ? '☔️ あめモード' : '☀️ はれモード'}`);
      } catch (e) {
        if (alive) setWxMsg('🛰️ 天気が とれませんでした。ボタンで えらんでね');
      }
    })();
    return () => { alive = false; };
  }, [ready, iso]);

  /* ---------- きょうの分をリセット ---------- */
  const ptOfKey = (k) => (k[0] === 'm' ? (MISSIONS.find((m) => `m${m.id}` === k)?.pt ?? 0) : 5);
  const resetDay = (all) => {
    const targets = all ? [0, 1] : [state.kid];
    const names = targets.map((i) => state.kids[i].name).join('と');
    Alert.alert(
      'きょうの分を リセット',
      `${Number(iso.slice(5,7))}月${Number(iso.slice(8))}日 の ${names} のチェックとポイントを 0に もどします。`,
      [
        { text:'やめる', style:'cancel' },
        { text:'リセットする', style:'destructive', onPress: () => setState((s) => {
            const done = { ...s.done };
            const day = (done[mmdd(iso)] || [[], []]).map((a) => [...a]);
            const kids = s.kids.map((x) => ({ ...x, stk:[...x.stk] }));
            targets.forEach((i) => {
              const sum = day[i].reduce((a, k) => a + ptOfKey(k), 0);
              kids[i].pt = Math.max(0, kids[i].pt - sum);
              kids[i].used = Math.min(kids[i].used, kids[i].pt);
              const need = Math.floor(kids[i].pt / PT_PER_STICKER);
              kids[i].stk = kids[i].stk.slice(0, need);
              day[i] = [];
            });
            done[mmdd(iso)] = day;
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            return { ...s, done, kids };
          }) },
      ]
    );
  };

  const ResetButtons = () => (
    <View style={{ marginBottom:14 }}>
      <TouchableOpacity onPress={() => resetDay(false)} style={s.reset}>
        <Text style={s.resetTx}>🔄 きょうの {kid.name} の分を リセット</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => resetDay(true)} style={[s.reset, { marginTop:8 }]}>
        <Text style={s.resetTx}>🔄🔄 きょうの ふたりとも リセット</Text>
      </TouchableOpacity>
    </View>
  );

  /* ---------- 現在地までスクロール ---------- */
  useEffect(() => {
    if (tab !== 'today' || !today) return;
    let cur = -1;
    timeline.forEach((e, i) => { if (toMin(e.time) <= nowMin) cur = i; });
    const y = yRef.current[cur];
    if (y != null) setTimeout(() => scRef.current?.scrollTo({ y: Math.max(0, y - 120), animated:true }), 250);
  }, [tab, iso, state.weather, ready]);

  /* ---------- ポイント ---------- */
  const dayKeys = () => state.done[mmdd(iso)] || [[], []];
  const has = (k) => dayKeys()[state.kid].includes(k);
  const toggle = (k, pt) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setState((s) => {
      const done = { ...s.done };
      const day = (done[mmdd(iso)] || [[], []]).map((a) => [...a]);
      const kids = s.kids.map((x) => ({ ...x, stk:[...x.stk] }));
      const me = kids[s.kid];
      const i = day[s.kid].indexOf(k);
      if (i >= 0) { day[s.kid].splice(i, 1); me.pt = Math.max(0, me.pt - pt); }
      else {
        day[s.kid].push(k);
        me.pt += pt;
        const need = Math.floor(me.pt / PT_PER_STICKER);
        while (me.stk.length < need) {
          me.stk.push(STICKERS[Math.floor(Math.random() * STICKERS.length)]);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      }
      done[mmdd(iso)] = day;
      return { ...s, done, kids };
    });
  };
  const buy = (item) => {
    if (avail < item.cost) return;
    Alert.alert('こうかんする？', `${item.title}（${item.cost}pt）`, [
      { text:'やめる', style:'cancel' },
      { text:'こうかん！', onPress: () => setState((s) => {
          const kids = s.kids.map((x, i) => i === s.kid ? { ...x, used: x.used + item.cost } : x);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return { ...s, kids };
        }) },
    ]);
  };

  if (!ready) return <SafeAreaView style={{ flex:1, backgroundColor:th.bg }} />;

  const curIdx = (() => { let c = -1; timeline.forEach((e, i) => { if (toMin(e.time) <= nowMin) c = i; }); return c; })();

  /* ---------- パーツ ---------- */
  const KidSwitch = () => (
    <View style={s.who}>
      {state.kids.map((k, i) => (
        <TouchableOpacity key={i} onPress={() => setState((x) => ({ ...x, kid:i }))}
          style={[s.whoBtn, state.kid === i && { backgroundColor:'#fff', borderColor:th.c3 }]}>
          {state.kid === i ? (
            <TextInput value={k.name} style={[s.whoTx, { color:INK }]}
              onChangeText={(v) => setState((x) => ({ ...x, kids: x.kids.map((y, j) => j === i ? { ...y, name:v } : y) }))} />
          ) : <Text style={[s.whoTx, { color:INK2 }]}>{k.name}</Text>}
          <Text style={s.whoPt}>{k.pt - k.used}pt</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  return (
    <View style={{ flex:1, backgroundColor:th.bg }}>
      <StatusBar barStyle="light-content" />
      <View style={{ backgroundColor:th.c1, paddingBottom:12 }}>
        <SafeAreaView>
          <View style={{ paddingHorizontal:16, paddingTop:8 }}>
            <Text style={s.logo}>なつやすみ大作戦</Text>
            <Text style={s.logoSub}>M I S S I O N   2 0 2 6</Text>

            {/* 天気スイッチ */}
            <View style={s.wsw}>
              {[['sun','☀️','はれ'], ['rain','☔️','あめ']].map(([w, e, l]) => (
                <TouchableOpacity key={w} onPress={() => { Haptics.selectionAsync(); setWxMsg('✋ 天気は 手動でえらんだままです'); setState((x) => ({ ...x, weather:w, manual:true, autoDay:mmdd(iso) })); }}
                  style={[s.wswBtn, state.weather === w && s.wswOn]}>
                  <Text style={{ fontSize:20 }}>{e}</Text>
                  <Text style={[s.wswTx, { color: state.weather === w ? INK : '#fff' }]}>{l}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={s.wxMsg}>{wxMsg}</Text>
          </View>
        </SafeAreaView>
      </View>

      <ScrollView ref={scRef} contentContainerStyle={{ padding:14, paddingBottom:110 }}>
        {/* きょうのパターン */}
        <View style={s.card}>
          <View style={{ flexDirection:'row', alignItems:'center', gap:10 }}>
            <View style={[s.badge, { backgroundColor:PCOLOR[pattern] }]}>
              <Text style={s.badgeTx}>{pattern === 'F' ? '休' : pattern === 'S' ? '泳' : pattern}</Text>
            </View>
            <View style={{ flex:1 }}>
              <Text style={s.pName}>{PNAME[pattern]}</Text>
              <Text style={s.pDate}>
                {Number(iso.slice(5,7))}月{Number(iso.slice(8))}日（{dow}）・{state.weather === 'sun' ? 'はれ ☀️' : 'あめ ☔️'}
              </Text>
            </View>
          </View>
          <View style={[s.memo, { backgroundColor:th.memo }]}>
            <Text style={{ color:th.memoTx, fontSize:12, lineHeight:18, fontFamily:FONT }}>
              {memo ? `📌 ${memo}` : 'きょうも いい1日にしよう！'}
            </Text>
          </View>
        </View>

        <KidSwitch />

        {/* ---- タイムライン ---- */}
        {tab === 'today' && (
          <View>
            {timeline.map((ev, i) => {
              const k = `t${ev.time}${i}`;
              const done = has(k);
              const go = ev.go && today && Math.abs(toMin(ev.time) - nowMin) <= 15 && !done;
              return (
                <View key={k} onLayout={(e) => { yRef.current[i] = e.nativeEvent.layout.y; }}
                  style={{ flexDirection:'row', gap:12, marginBottom:10, opacity: done ? 0.45 : 1 }}>
                  <View style={[s.dot, { borderColor: go ? th.c3 : th.c1 }]}>
                    <Text style={{ fontSize:20 }}>{ev.icon}</Text>
                  </View>
                  <TouchableOpacity activeOpacity={0.8} onPress={() => toggle(k, 5)}
                    style={[s.evBody, today && i === curIdx && { borderColor:th.c2, borderWidth:3 }]}>
                    <View style={{ flex:1 }}>
                      <Text style={[s.evTime, { color:th.c3 }]}>{ev.time}</Text>
                      <Text style={[s.evName, go && { color:'#E2544B' }]}>{ev.title}</Text>
                      {!!ev.note && <Text style={s.evNote}>{ev.note}</Text>}
                    </View>
                    <View style={[s.chk, done && { backgroundColor:OK, borderColor:OK }]}>
                      <Text style={{ color: done ? '#fff' : 'transparent', fontWeight:'800' }}>✓</Text>
                    </View>
                  </TouchableOpacity>
                </View>
              );
            })}
            <View style={{ height:8 }} />
            <ResetButtons />
          </View>
        )}

        {/* ---- ミッション ---- */}
        {tab === 'mission' && (
          <View style={s.card}>
            <Text style={s.h3}>🎯 きょうのミッション</Text>
            {MISSIONS.map((m) => {
              const k = `m${m.id}`; const done = has(k);
              return (
                <TouchableOpacity key={k} activeOpacity={0.8} onPress={() => toggle(k, m.pt)}
                  style={[s.ms, done && { opacity:0.45 }]}>
                  <Text style={{ fontSize:22 }}>{m.icon}</Text>
                  <Text style={[s.msName, done && { textDecorationLine:'line-through' }]}>{m.title}</Text>
                  <Text style={s.msPt}>+{m.pt}pt</Text>
                  <View style={[s.chk, done && { backgroundColor:OK, borderColor:OK }]}>
                    <Text style={{ color: done ? '#fff' : 'transparent', fontWeight:'800' }}>✓</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        {tab === 'mission' && <ResetButtons />}

        {/* ---- シールちょう ---- */}
        {tab === 'sticker' && (
          <View>
            <View style={{ flexDirection:'row', gap:10, marginBottom:12 }}>
              {[[avail, 'つかえるpt'], [kid.stk.length, 'シール'], [kid.pt, 'ためたpt']].map(([v, l], i) => (
                <View key={i} style={[s.card, { flex:1, alignItems:'center', marginBottom:0 }]}>
                  <Text style={[s.scV, { color:th.c3 }]}>{v}</Text>
                  <Text style={s.scL}>{l}</Text>
                </View>
              ))}
            </View>
            <View style={s.card}>
              <Text style={s.h3}>🏅 {kid.name} のシールちょう（{PT_PER_STICKER}ptで1まい）</Text>
              <View style={{ flexDirection:'row', flexWrap:'wrap', gap:8 }}>
                {Array.from({ length: Math.max(20, Math.ceil((kid.stk.length + 1) / 5) * 5) }).map((_, i) => (
                  <View key={i} style={[s.slot, i < kid.stk.length && { backgroundColor:'#fff', borderColor:th.c2, borderStyle:'solid' }]}>
                    <Text style={{ fontSize:24 }}>{kid.stk[i] || ''}</Text>
                  </View>
                ))}
              </View>
            </View>
            <View style={s.card}>
              <Text style={s.h3}>🎁 ごほうび こうかん</Text>
              {SHOP.map((it) => (
                <View key={it.title} style={[s.shop, { backgroundColor:th.memo }]}>
                  <Text style={{ fontSize:22 }}>{it.icon}</Text>
                  <Text style={s.msName}>{it.title}</Text>
                  <Text style={s.msPt}>{it.cost}pt</Text>
                  <TouchableOpacity disabled={avail < it.cost} onPress={() => buy(it)}
                    style={[s.buy, { backgroundColor: avail < it.cost ? '#D6D2E4' : th.c3 }]}>
                    <Text style={s.buyTx}>こうかん</Text>
                  </TouchableOpacity>
                </View>
              ))}
              <Text style={{ fontSize:11, color:INK2, marginTop:6, fontFamily:FONT }}>
                ※ こうかんは 週まつに おうちの人といっしょに！
              </Text>
            </View>
          </View>
        )}

        {/* ---- カレンダー ---- */}
        {tab === 'cal' && [7, 8].map((mo) => (
          <View key={mo} style={s.card}>
            <Text style={s.h3}>🗓️ {mo}月</Text>
            <View style={{ flexDirection:'row', flexWrap:'wrap' }}>
              {['日','月','火','水','木','金','土'].map((d) => (
                <Text key={d} style={s.calH}>{d}</Text>
              ))}
              {Array.from({ length: new Date(2026, mo - 1, 1).getDay() }).map((_, i) => (
                <View key={`e${i}`} style={s.calCell} />
              ))}
              {Array.from({ length: new Date(2026, mo, 0).getDate() }).map((_, i) => {
                const d = i + 1;
                const k = `${pad(mo)}-${pad(d)}`;
                const c = CALENDAR[k];
                const target = `2026-${k}`;
                return (
                  <TouchableOpacity key={k} disabled={!c} onPress={() => { setIso(target); setTab('today'); }}
                    style={[s.calCell, { opacity: c ? 1 : 0.3 }, iso === target && { borderColor:th.c3, borderWidth:2 }]}>
                    <Text style={s.calNum}>{d}</Text>
                    {c && (
                      <View style={[s.calP, { backgroundColor:PCOLOR[c[0]] }]}>
                        <Text style={s.calPTx}>{c[0] === 'F' ? '休' : c[0] === 'S' ? '泳' : c[0]}</Text>
                      </View>
                    )}
                    {c && c[2].includes('ケアタイム') && <Text style={{ fontSize:9 }}>☕</Text>}
                    {c && c[2].includes('お盆') && <Text style={{ fontSize:9 }}>🏮</Text>}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>

      {/* ---- タブ ---- */}
      <View style={s.tabs}>
        {[['today','📋','きょう'], ['mission','🎯','ミッション'], ['sticker','🏅','シールちょう'], ['cal','🗓️','カレンダー']].map(([v, e, l]) => (
          <TouchableOpacity key={v} onPress={() => { Haptics.selectionAsync(); setTab(v); }} style={s.tab}>
            <Text style={{ fontSize:21, opacity: tab === v ? 1 : 0.4 }}>{e}</Text>
            <Text style={[s.tabTx, { color: tab === v ? INK : '#B6B2C7' }]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  logo:{ fontSize:22, fontWeight:'800', color:'#fff', fontFamily:FONT },
  logoSub:{ fontSize:10, color:'rgba(255,255,255,.9)', marginBottom:10, fontFamily:FONT },
  wsw:{ flexDirection:'row', backgroundColor:'rgba(255,255,255,.35)', borderRadius:999, padding:5 },
  wswBtn:{ flex:1, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8, paddingVertical:11, borderRadius:999 },
  wswOn:{ backgroundColor:'#fff' },
  wswTx:{ fontSize:15, fontWeight:'800', fontFamily:FONT },

  wxMsg:{ fontSize:11, color:'#fff', textAlign:'center', marginTop:8, fontWeight:'700', fontFamily:FONT },
  reset:{ paddingVertical:11, borderRadius:14, backgroundColor:'rgba(255,255,255,.75)',
          borderWidth:2, borderColor:'#E7E3F3', alignItems:'center' },
  resetTx:{ fontSize:12, fontWeight:'800', color:INK2, fontFamily:FONT },
  card:{ backgroundColor:'#fff', borderRadius:22, padding:14, marginBottom:12,
         shadowColor:'#3B3355', shadowOpacity:0.08, shadowRadius:0, shadowOffset:{ width:0, height:5 }, elevation:2 },
  badge:{ width:44, height:44, borderRadius:14, alignItems:'center', justifyContent:'center' },
  badgeTx:{ color:'#fff', fontSize:20, fontWeight:'800', fontFamily:FONT },
  pName:{ fontSize:16, fontWeight:'800', color:INK, fontFamily:FONT },
  pDate:{ fontSize:12, color:INK2, fontFamily:FONT },
  memo:{ marginTop:10, borderRadius:12, padding:9 },
  h3:{ fontSize:15, fontWeight:'800', color:INK, marginBottom:10, fontFamily:FONT },

  who:{ flexDirection:'row', gap:8, marginBottom:12 },
  whoBtn:{ flex:1, alignItems:'center', paddingVertical:10, borderRadius:16, borderWidth:2,
           borderColor:'transparent', backgroundColor:'rgba(255,255,255,.6)' },
  whoTx:{ fontSize:14, fontWeight:'800', textAlign:'center', fontFamily:FONT },
  whoPt:{ fontSize:11, color:INK2, fontFamily:FONT },

  dot:{ width:44, height:44, borderRadius:22, backgroundColor:'#fff', borderWidth:3,
        alignItems:'center', justifyContent:'center' },
  evBody:{ flex:1, flexDirection:'row', alignItems:'center', backgroundColor:'#fff',
           borderRadius:18, padding:11, borderWidth:3, borderColor:'transparent' },
  evTime:{ fontSize:12, fontWeight:'800', fontFamily:FONT },
  evName:{ fontSize:15, fontWeight:'800', color:INK, fontFamily:FONT },
  evNote:{ fontSize:11, color:INK2, marginTop:2, fontFamily:FONT },
  chk:{ width:34, height:34, borderRadius:12, borderWidth:3, borderColor:'#E7E3F3',
        alignItems:'center', justifyContent:'center', marginLeft:8 },

  ms:{ flexDirection:'row', alignItems:'center', gap:10, padding:10, borderRadius:14,
       backgroundColor:'#FAF8FF', marginBottom:8 },
  msName:{ flex:1, fontSize:14, fontWeight:'800', color:INK, fontFamily:FONT },
  msPt:{ fontSize:11, color:INK2, fontFamily:FONT },

  scV:{ fontSize:26, fontWeight:'800', fontFamily:FONT },
  scL:{ fontSize:11, color:INK2, fontFamily:FONT },
  slot:{ width:'17.5%', aspectRatio:1, borderRadius:14, backgroundColor:'#F6F3FF',
         borderWidth:2, borderColor:'#DCD5F0', borderStyle:'dashed',
         alignItems:'center', justifyContent:'center' },
  shop:{ flexDirection:'row', alignItems:'center', gap:10, padding:10, borderRadius:14, marginBottom:8 },
  buy:{ paddingVertical:9, paddingHorizontal:14, borderRadius:12 },
  buyTx:{ color:'#fff', fontWeight:'800', fontSize:12, fontFamily:FONT },

  calH:{ width:`${100/7}%`, textAlign:'center', fontSize:10, color:INK2, paddingBottom:4, fontFamily:FONT },
  calCell:{ width:`${100/7}%`, aspectRatio:0.82, alignItems:'center', paddingTop:3,
            borderRadius:10, borderWidth:2, borderColor:'transparent' },
  calNum:{ fontSize:12, fontWeight:'800', color:INK, fontFamily:FONT },
  calP:{ width:19, height:19, borderRadius:7, alignItems:'center', justifyContent:'center', marginTop:2 },
  calPTx:{ color:'#fff', fontSize:10, fontWeight:'800', fontFamily:FONT },

  tabs:{ position:'absolute', left:0, right:0, bottom:0, flexDirection:'row',
         backgroundColor:'#fff', borderTopWidth:2, borderTopColor:'#E7E3F3',
         paddingTop:6, paddingBottom:Platform.OS === 'ios' ? 24 : 8 },
  tab:{ flex:1, alignItems:'center', gap:2 },
  tabTx:{ fontSize:10, fontWeight:'800', fontFamily:FONT },
});
