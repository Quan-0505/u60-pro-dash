'use strict';
(() => {
  const {el,button,panel,status,say,request,json,confirm,mutate} = OpenU60UI;
  const section = panel('dashboard/functions','u60-functions','功能列表','沿用高级后台的分类；常用功能在 6060 内打开。');
  section.dataset.views = 'dashboard/functions dashboard/overview';
  const search = el('input','u60-function-search'); search.type = 'search';
  search.placeholder = '搜索功能，如 Wi-Fi、短信、ADB'; search.setAttribute('aria-label','搜索功能');
  section.append(search);
  const groups = [
    ['网络与连接',[
      ['WIFI设置','network/wifi'],['访客 Wi-Fi','network/wifi'],['接入设备','network/clients'],
      ['内网设置','network/lan'],['数据开关 / 漫游','network/mobile'],['网络制式','network/mobile'],
      ['APN设置','network/apn'],['锁定频段 / 基站','network/bands'],['信号参数','network/signal'],['邻区基站','tools/radio']]],
    ['短信与流量',[
      ['短信收发','sms/inbox'],['短信转发','sms/forwarding'],['流量管理 / 套餐','tools/data'],
      ['实时流量','tools/traffic'],['流量测速','tools/speedtest']]],
    ['设备与维护',[
      ['插件商店目录','tools/catalog'],['CPU 性能模式','tools/performance'],['混合直供与充电','tools/power'],['Wi-Fi 节能','tools/wifi-power'],['插件管理','tools/plugins'],['开机脚本','tools/startup'],['定时任务','tools/scheduler'],['USB / NFC','tools/hardware'],['内网测速','tools/lan-test'],
      ['电池与电源','tools/battery'],['设备监控','tools/diagnostics'],['休眠设置','settings/device'],
      ['重启设备','settings/device'],['设备信息','tools/device'],['主题外观','settings/appearance'],
      ['后台程序更新','settings/update'],['代理服务','network/proxy']]]
  ];
  const filterable = [];
  for (const [title,items] of groups) {
    const group = el('section','u60-function-group'); group.append(el('h3','',title));
    const grid = el('div','u60-function-grid');
    for (const [label,route] of items) {
      const link = el('a','button',label); link.href = `#${route}`; grid.append(link); filterable.push(link);
    }
    group.append(grid); section.append(group);
  }
  const adb = el('section','u60-function-group'); adb.append(el('h3','','ADB 调试'));
  adb.append(el('p','section-subtitle','分别显示实际运行状态和开机设置。操作后可重新读取确认。'));
  const adbGrid = el('div','u60-function-grid'); adb.append(adbGrid); section.append(adb);
  const feedback = status(section);
  let epoch = 0, loading = false, attempted = false;
  const controls = ['wired','wireless'].map(kind => {
    const label = kind === 'wired' ? '有线 ADB' : '无线 ADB';
    const card = el('div','u60-adb-card'), state = el('p','','尚未读取');
    const toggle = button(label); toggle.setAttribute('role','switch'); toggle.disabled = true;
    card.append(toggle,state); adbGrid.append(card);
    const control = {kind,label,toggle,state,value:null};
    toggle.addEventListener('click',async () => {
      if (!control.value) return;
      const enabled = !control.value.enabled;
      const warning = kind === 'wireless'
        ? '无线 ADB 提供局域网 root 调试访问。仅应在可信网络下开启；设置会在重启后保留。'
        : '更改有线 ADB 会影响 USB 调试连接；设置会在重启后保留。';
      if (!await confirm(`${enabled ? '开启' : '关闭'}${label}？`,warning,{label:'确认更改'})) return;
      await mutate(feedback,async current => {
        toggle.disabled = true;
        try {
          await request(`/api/u60/adb/${kind}`,json('PUT',{enabled}));
          if (current()) say(feedback,'设置已提交。服务可能需要几秒切换，请重新读取确认实际运行状态。');
        } finally { if (current()) await read(); }
      });
    });
    return control;
  });
  async function read() {
    if (loading || OpenU60Console.locked) return;
    loading = true; attempted = true; const generation = epoch;
    await Promise.all(controls.map(async control => {
      control.toggle.disabled = true;
      try {
        const value = await request(`/api/u60/adb/${control.kind}`);
        if (generation !== epoch) return;
        control.value = value;
        control.toggle.setAttribute('aria-checked',String(value.enabled));
        control.state.textContent = `${value.active ? '运行中' : '未运行'} · 开机${value.enabled ? '开启' : '关闭'}`;
        control.toggle.disabled = false;
      } catch (error) {
        if (generation !== epoch) return;
        control.value = null; control.state.textContent = `状态不可用：${error.message}`;
      }
    }));
    loading = false;
  }
  section.append(button('重新读取 ADB 状态',read));
  const legacy = el('section','u60-function-group'); legacy.append(el('h3','','备用管理入口'));
  legacy.append(el('p','section-subtitle','扩展控制已接入上方原生页面。2333 保留为备用入口；第三方页面插件与备用后台共用存储。'));
  const legacyLink = el('a','button','打开 2333 高级后台 ↗');
  const legacyURL = new URL(location.href); legacyURL.protocol = 'http:'; legacyURL.port = '2333'; legacyURL.pathname = '/'; legacyURL.search = ''; legacyURL.hash = '';
  legacyLink.href = legacyURL.href; legacyLink.target = '_blank'; legacyLink.rel = 'noopener noreferrer';
  legacy.append(legacyLink); section.append(legacy);
  const empty = el('p','','没有匹配的功能'); empty.hidden = true; section.append(empty);
  search.addEventListener('input',() => {
    const query = search.value.trim().toLocaleLowerCase();
    for (const link of filterable) link.hidden = !link.textContent.toLocaleLowerCase().includes(query);
    for (const group of section.querySelectorAll('.u60-function-group')) {
      const links = [...group.querySelectorAll('a')];
      group.hidden = group === adb || group === legacy
        ? !!query && !group.textContent.toLocaleLowerCase().includes(query)
        : links.every(link => link.hidden);
    }
    empty.hidden = !query || [...section.querySelectorAll('.u60-function-group')].some(group => !group.hidden);
  });
  const sync = () => {
    const key = OpenU60Navigation.current.key;
    section.dataset.viewHidden = String(!section.dataset.views.split(' ').includes(key));
    if (section.dataset.viewHidden === 'false' && OpenU60Console.connected) read();
  };
  window.addEventListener('dashboard:navigate',sync);
  window.addEventListener('dashboard:readings',() => {
    if (!attempted && section.dataset.viewHidden === 'false') read();
  });
  window.addEventListener('dashboard:locked',() => {
    epoch++; attempted = false;
    for (const control of controls) { control.value = null; control.toggle.disabled = true; control.toggle.removeAttribute('aria-checked'); control.state.textContent = '请解锁后台后读取'; }
    feedback.textContent = '';
  });
  sync();
})();
