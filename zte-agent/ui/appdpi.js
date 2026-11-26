'use strict';
(() => {
  const {el} = OpenU60UI;
  const route = 'network/appdpi';
  const zh = () => document.documentElement.lang.toLowerCase().startsWith('zh');
  const label = (en, cn) => zh() ? cn : en;
  const list = value => Array.isArray(value) ? value : [];
  const bytes = value => {
    let n = Number(value) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unit = 0;
    while (n >= 1000 && unit < units.length - 1) { n /= 1000; unit++; }
    return n.toLocaleString(undefined, {maximumFractionDigits: 2}) + ' ' + units[unit];
  };
  const panel = el('section', 'panel');
  panel.dataset.views = route;
  panel.dataset.viewHidden = String(OpenU60Navigation.current.key !== route);
  const heading = el('div', 'section-heading');
  heading.append(el('h2', '', label('Application traffic', '应用识别')));
  const source = el('span', 'tag', 'AppDPI');
  heading.append(source);
  const state = el('p', '', '');
  state.setAttribute('role', 'status');
  const output = el('div', '');
  panel.append(heading, state, output);
  document.getElementById('main').append(panel);

  const table = (headers, rows) => {
    if (!rows.length) return el('p', '', label('No data in this sample.', '当前采样暂无数据。'));
    const wrapper = el('div', 'table-wrap');
    wrapper.style.overflowX = 'auto';
    const table = el('table', '');
    const header = table.createTHead().insertRow();
    for (const title of headers) {
      const cell = el('th', '', title);
      cell.scope = 'col';
      header.append(cell);
    }
    const body = table.createTBody();
    for (const row of rows) {
      const target = body.insertRow();
      for (const value of row) target.insertCell().textContent = String(value ?? '—');
    }
    wrapper.append(table);
    return wrapper;
  };
  const closed = new Set();
  function details(title, key, content) {
    const block = el('details', '');
    block.open = !closed.has(key);
    block.append(el('summary', '', title), content);
    block.addEventListener('toggle', () => {
      if (!block.isConnected) return;
      if (block.open) closed.delete(key);
      else closed.add(key);
    });
    return block;
  }
  const appName = row => (zh() && row.app_name_zh) || row.app_name || row.name || row.app_id || '—';
  function render(data) {
    const devices = list(data.devices);
    const active = devices.filter(device => device.live === true || device.live === 1);
    const apps = list(data.apps);
    const flows = list(data.connections);
    state.textContent = [
      label('Online', '在线设备') + ' ' + active.length,
      label('Applications', '识别应用') + ' ' + apps.length,
      label('Packets', '采集包数') + ' ' + (data.meta?.pkts ?? '—'),
      new Date(data.meta.ts * 1000).toLocaleTimeString()
    ].join(' · ');
    source.textContent = 'AppDPI · ' + (data.meta.iface || 'LAN');
    const appTitles = [label('Application', '应用'), label('Traffic', '流量')];
    const appRows = rows => rows.map(row => [appName(row), bytes(row.bytes ?? ((row.in_bytes || 0) + (row.out_bytes || 0)))]);
    const devicePanels = el('div', '');
    if (!devices.length) devicePanels.append(el('p', '', label('No devices in this sample.', '当前采样暂无设备。')));
    for (const device of devices.slice(0, 40)) {
      const matches = row => row.dev === device.ip || (device.mac && row.mac === device.mac);
      const summary = [device.hostname, device.ip, device.live ? label('Online', '在线') : label('Offline', '离线')].filter(Boolean).join(' · ');
      const content = el('div', '');
      content.append(el('p', '', label('Download', '下行') + ' ' + bytes(device.in_bytes) + ' · ' + label('Upload', '上行') + ' ' + bytes(device.out_bytes)));
      content.append(table(appTitles, appRows(list(data.device_apps).filter(matches))));
      devicePanels.append(details(summary, 'device:' + (device.mac || device.ip), content));
    }
    output.replaceChildren(
      details(label('LAN devices', '内网设备'), 'devices', devicePanels),
      details(label('Application distribution', '应用分布'), 'apps', table(appTitles, appRows(apps))),
      details(label('Recent connections', '最近连接'), 'connections', table(
        [label('Device', '设备'), label('Peer', '对端'), label('Domain', '域名'), label('Traffic', '流量')],
        flows.slice(0, 50).map(flow => [flow.dev, flow.dport ? flow.peer + ' · ' + flow.dport : flow.peer, flow.domain || '—', bytes(flow.bytes)])
      ))
    );
  }

  let loading = false;
  let generation = 0;
  async function refresh() {
    if (loading || document.hidden || OpenU60Console.locked || OpenU60Navigation.current.key !== route) return;
    loading = true;
    const current = generation;
    try {
      const data = await OpenU60Console.request('/api/u60/appdpi', {timeoutMs: 3500});
      if (current === generation && !OpenU60Console.locked) render(data);
    } catch {
      if (current !== generation) return;
      state.textContent = label('AppDPI data unavailable.', '暂时无法读取 AppDPI 数据。');
      output.replaceChildren();
    } finally {
      loading = false;
    }
  }
  window.addEventListener('dashboard:navigate', event => {
    if (event.detail.key === route) refresh();
  });
  window.addEventListener('dashboard:locked', () => {
    generation++;
    output.replaceChildren();
    state.textContent = '';
  });
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 5000);
  refresh();
})();
