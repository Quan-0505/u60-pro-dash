'use strict';
(() => {
  const {el} = OpenU60UI;
  const base = 'openwrt/';
  const zh = OpenU60I18n.locale.startsWith('zh');
  const lang = (cn, en) => zh ? cn : en;
  const tables = {
    mounts: [['target', '挂载点', 'Mount point'], ['source', '来源', 'Source'], ['filesystem', '文件系统', 'Filesystem'], ['readonly', '权限', 'Mode']],
    packages: [['name', '软件包', 'Package'], ['version', '版本', 'Version'], ['architecture', '架构', 'Architecture']]
  };
  const lu = '/cgi-bin/luci/admin/';
  const groups = [
    [lang('状态', 'Status'), [
      ['概览','Overview','#dashboard/overview'], ['系统日志','System log','#openwrt/system-log'],
      ['内核日志','Kernel log','#openwrt/kernel-log'], ['进程','Processes','#tools/diagnostics'],
      ['运行时路由','Runtime routes','status/routes'], ['防火墙状态','Firewall status','status/nftables'],
      ['实时负载','Realtime load','status/realtime/load'], ['实时带宽','Realtime bandwidth','#tools/traffic'],
      ['无线状态','Wireless status','status/realtime/wireless'], ['连接状态','Connections','#network/appdpi'],
      ['无线信道分析','Channel analysis','status/channel_analysis']
    ]],
    [lang('系统', 'System'), [
      ['系统设置','System settings','system/system'], ['设备与电源','Device and power','#settings/device'],
      ['路由器密码','Router password','system/admin/password'], ['SSH 访问','SSH access','system/admin/dropbear'],
      ['SSH 公钥','SSH keys','system/admin/sshkeys'], ['HTTP(S) 访问','HTTP(S) access','system/admin/uhttpd'],
      ['OpenU60 HTTPS','OpenU60 HTTPS','#settings/https'], ['软件源公钥','Repository keys','system/admin/repokeys'],
      ['启动项服务','Startup services','system/startup'], ['开机脚本','Startup script','#tools/startup'],
      ['定时任务','Scheduled tasks','#tools/scheduler'], ['挂载信息','Mount information','#openwrt/mounts'],
      ['挂载设置','Mount settings','system/mounts'], ['LED 设置','LED configuration','system/leds'],
      ['已安装软件','Installed software','#openwrt/packages'], ['软件包管理','Package management','system/package-manager'],
      ['备份与刷机','Backup and firmware','system/flash'], ['重启页面','Reboot page','system/reboot']
    ]],
    [lang('网络', 'Network'), [
      ['接口','Interfaces','network/network'], ['交换机','Switch','network/switch'],
      ['无线','Wireless','#network/wifi'], ['无线配置（LuCI）','Wireless configuration (LuCI)','network/wireless'],
      ['静态路由','Static routes','network/routes'], ['LAN 与 DHCP','LAN and DHCP','#network/lan'],
      ['高级 DHCP/DNS','Advanced DHCP/DNS','network/dhcp'], ['DNS 与隐私','DNS and privacy','#network/dns'],
      ['WireGuard','WireGuard','#network/vpn'], ['网络诊断','Network diagnostics','network/diagnostics'],
      ['防火墙区域','Firewall zones','network/firewall/zones'], ['端口转发','Port forwards','#network/ports'],
      ['高级端口转发','Advanced port forwards','network/firewall/forwards'], ['流量规则','Traffic rules','network/firewall/rules'],
      ['NAT 规则','NAT rules','network/firewall/snats'], ['IP 集合','IP sets','network/firewall/ipsets'],
      ['自定义规则','Custom rules','network/firewall/custom']
    ]]
  ];
  function section(route) {
    const panel = el('section', 'panel');
    panel.dataset.views = base + route;
    panel.dataset.viewHidden = String(OpenU60Navigation.current.key !== base + route);
    document.getElementById('main').append(panel);
    return panel;
  }
  const full = section('full');
  const actions = el('div', 'section-heading');
  const external = el('a', 'button secondary', lang('在新标签页打开 LuCI', 'Open LuCI in a new tab'));
  external.href = '/cgi-bin/luci/';
  external.target = '_blank';
  external.rel = 'noopener';
  actions.append(external);
  full.append(actions);
  let frame;
  function openLuci() {
    if (frame || OpenU60Console.locked || OpenU60Navigation.current.key !== base + 'full') return;
    frame = el('iframe', '');
    frame.title = 'OpenWrt LuCI';
    frame.src = '/cgi-bin/luci/';
    frame.style.cssText = 'width:100%;height:max(680px,75vh);border:0;display:block';
    frame.addEventListener('load', () => {
      const brand = frame?.contentDocument?.querySelector('a.brand[href="/"]');
      if (brand) brand.href = '/cgi-bin/luci/';
    });
    full.append(frame);
  }
  window.addEventListener('dashboard:navigate', openLuci);
  window.addEventListener('dashboard:readings', openLuci);
  window.addEventListener('dashboard:locked', () => {
    frame?.remove();
    frame = undefined;
  });
  openLuci();

  const index = section('index');
  for (const [group, rows] of groups) {
    index.append(el('h2', '', group));
    const links = el('ul', '');
    for (const [cn, en, route] of rows) {
      const item = el('li', '');
      const native = route.startsWith('#');
      const link = el('a', '', lang(cn, en));
      if (native) link.href = route;
      else {
        link.href = lu + route;
        link.target = '_blank';
        link.rel = 'noopener';
      }
      item.append(link, document.createTextNode(native ? ' · OpenU60' : ' · LuCI 24.10'));
      links.append(item);
    }
    index.append(links);
  }

  function renderTable(data, columns) {
    const wrapper = el('div', '');
    wrapper.style.overflowX = 'auto';
    const table = el('table', '');
    const header = table.createTHead().insertRow();
    for (const [, cn, en] of columns) {
      const th = el('th', '', lang(cn, en));
      th.scope = 'col';
      header.append(th);
    }
    const body = table.createTBody();
    for (const entry of data.entries) {
      const row = body.insertRow();
      for (const [key] of columns) {
        row.insertCell().textContent = key === 'readonly' ? (entry[key] ? 'ro' : 'rw') : entry[key];
      }
    }
    wrapper.append(table);
    return wrapper;
  }

  for (const route of ['system-log', 'kernel-log', 'mounts', 'packages']) {
    const panel = section(route);
    const heading = el('div', 'section-heading');
    const refresh = el('button', 'button secondary', lang('刷新', 'Refresh'));
    refresh.type = 'button';
    const status = el('p', '');
    status.setAttribute('role', 'status');
    const output = el('div', '');
    heading.append(el('span', 'tag', route === 'packages' ? 'LuCI · OpenWrt 24.10' : 'U60 · OpenWrt 23.05'), refresh);
    panel.append(heading, status, output);

    let request = 0;
    let loaded = false;
    async function load() {
      if (OpenU60Console.locked) return;
      const current = ++request;
      refresh.disabled = true;
      loaded = true;
      status.textContent = lang('读取中…', 'Loading…');
      try {
        const data = await OpenU60Console.request('/api/u60/openwrt/' + route);
        if (current !== request || OpenU60Console.locked) return;
        const content = tables[route] ? renderTable(data, tables[route]) : el('pre', '', data.text);
        if (content.tagName === 'PRE') content.style.whiteSpace = 'pre-wrap';
        output.replaceChildren(content);
        status.textContent = data.entries ? String(data.entries.length) + lang(' 条', ' entries') : '';
      } catch {
        if (current === request) status.textContent = lang('暂时无法读取。', 'Data is unavailable.');
      } finally {
        if (current === request) refresh.disabled = false;
      }
    }
    refresh.addEventListener('click', load);
    const enter = () => { if (OpenU60Navigation.current.key === base + route && !loaded && !refresh.disabled) load(); };
    window.addEventListener('dashboard:navigate', enter);
    window.addEventListener('dashboard:readings', enter);
    window.addEventListener('dashboard:locked', () => {
      request++;
      loaded = false;
      refresh.disabled = false;
      status.textContent = '';
      output.replaceChildren();
    });
    enter();
  }
})();
