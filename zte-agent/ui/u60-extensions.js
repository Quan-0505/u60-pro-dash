'use strict';
(() => {
  const U=OpenU60UI, C=OpenU60Console;
  const base='/api/u60/extensions/';
  const bool=(key,label)=>U.choices(key,label,[['true','开启'],['false','关闭']],{boolean:true});
  U.makeForm({route:'tools/performance',id:'u60-cpu-form',title:'CPU 模式与开机恢复',description:'保存前后回读实际 governor；不支持 schedutil 时均衡回退为性能。',endpoint:base+'cpu',fields:[U.choices('mode','性能模式',[['powersave','省电'],['balance','均衡'],['performance','性能'],['restore','恢复系统默认范围']]),bool('autostart','设备开机恢复')],body:(_,v)=>({mode:v.mode,autostart:v.autostart==='true'}),warning:'切换会改变耗电、温度与响应速度；设备温控继续生效。'});
  U.makeForm({route:'tools/power',id:'u60-battery-form',title:'混合直供与充电策略',description:'沿用设备电池监控配置。保存只更新策略，实际状态由监控程序根据电流、温度和输入条件决定。',endpoint:base+'battery',fields:[bool('bypass_power','手动混合直供'),bool('auto_bypass','自动混合直供'),bool('charge_limit','充电上限保护'),U.field('charge_val','停止充电电量 (%)',{type:'number',min:10,max:100}),U.field('charge_recover','恢复充电回差 (%)',{type:'number',min:1,max:20}),U.field('charge_cur','充电限流 (mA，留空恢复原厂)',{type:'text',placeholder:'500–5000，留空恢复原厂'})],body:(_,v)=>({bypass_power:v.bypass_power==='true',auto_bypass:v.auto_bypass==='true',charge_limit:v.charge_limit==='true',charge_val:Number(v.charge_val),charge_recover:Number(v.charge_recover),charge_cur:v.charge_cur===''?null:Number(v.charge_cur)}),warning:'手动与自动混合直供互斥。开启直供并不保证任何负载下都处于直供，监控程序会在高负载时退出。'});
  const telemetry=U.panel('tools/performance','u60-cpu-live','实际 CPU 状态','读取每个频率策略的 governor 和频率。');
  const cpuText=U.el('pre',''); telemetry.append(cpuText);
  const power=U.panel('tools/power','u60-power-live','控制器与电源实际状态','策略开关与实际工作状态分别显示。');
  const powerText=U.el('pre','');power.append(powerText);
  const wifi=U.panel('tools/wifi-power','u60-wifi-power','Wi-Fi 节能与覆盖','接口关闭或重载无线网络可能断开当前连接。');
  const wf=U.status(wifi), ws=U.el('pre','');wifi.append(ws);
  async function loadWifi(){try{const d=await U.request(base+'wifi');ws.textContent=`保存设置：\n${JSON.stringify(d.saved,null,2)}\n实际接口：\n${d.runtime}\n覆盖：${d.coverage}`;}catch(e){U.say(wf,e.message,true);}}
  async function wifiChange(body,label){if(!await U.confirm(label,'可能影响当前 Wi-Fi 连接。设置会保存到原节能插件。'))return;await U.mutate(wf,async()=>{await U.request(base+'wifi',U.json('PUT',body));await loadWifi();});}
  for(const iface of ['wlan0','wlan1','wlan2','wlan3']){const row=U.el('div','form-actions');row.append(U.el('strong','',iface),U.button('开启',()=>wifiChange({operation:'interface',interface:iface,value:'up'},`开启 ${iface}？`)),U.button('关闭',()=>wifiChange({operation:'interface',interface:iface,value:'down'},`关闭 ${iface}？`)));wifi.append(row);}
  const actions=U.el('div','form-actions');for(const [label,operation,value]of [['开启节能','psm','on'],['关闭节能','psm','off'],['近距离','coverage','near'],['标准覆盖','coverage','standard'],['穿墙覆盖','coverage','wall']])actions.append(U.button(label,()=>wifiChange({operation,value},`${label}？`)));wifi.append(actions,U.button('重新读取',loadWifi));
  for(const id of ['charge-config','manual-charge']){const old=document.getElementById(id);if(old){old.hidden=true;old.dataset.views='';}}
  const redirect=U.panel('settings/device','u60-charge-owner','充电控制','本机由常驻电池监控程序统一执行充电、混合直供与限流。');const powerLink=U.el('a','button','打开混合直供与充电');powerLink.href='#tools/power';redirect.append(powerLink);
  // Editors keep a read baseline so concurrent edits from the other console cannot be overwritten silently.
  function editor(key,title,description,endpoint){
    const section=U.panel(key,`u60-${endpoint}-editor`,title,description), feedback=U.status(section);
    const input=U.el('textarea','');input.rows=20;input.spellcheck=false;input.setAttribute('aria-label',title);input.style.width='100%';input.style.fontFamily='monospace';section.append(input);
    let baseline=null;
    async function load(){try{const d=await U.request(base+endpoint);baseline=d.source;input.value=d.source;U.say(feedback,'已读取设备当前内容。');}catch(e){U.say(feedback,e.message,true);}}
    const bar=U.el('div','form-actions');bar.append(U.button('读取当前内容',async()=>{if(baseline!==null&&input.value!==baseline&&!await U.confirm('丢弃未保存修改？','将重新读取设备内容。'))return;await load();}),U.button('校验并保存',async()=>{
      if(baseline===null){U.say(feedback,'先读取当前内容。',true);return;}
      if(!await U.confirm(`保存${title}？`,endpoint==='plugins'?'插件代码可执行设备命令。只保存可信代码；备用后台也会使用这些修改。':'脚本会在下次开机执行。保存前由设备进行 shell 语法检查。'))return;
      await U.mutate(feedback,async()=>{const d=await U.request(base+endpoint,U.json('PUT',{source:input.value,previous_source:baseline}));baseline=d.source;input.value=d.source;U.say(feedback,'已保存并回读确认。');});
    }),U.button('导出',()=>{const url=URL.createObjectURL(new Blob([input.value],{type:'text/plain;charset=utf-8'})),a=U.el('a');a.href=url;a.download=endpoint==='plugins'?'u60-plugins.html':'rc.local';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}));
    const file=U.el('input');file.type='file';file.setAttribute('aria-label',`导入${title}`);file.addEventListener('change',async()=>{const f=file.files?.[0];if(f){if(f.size>2*1024*1024){U.say(feedback,'文件超过2 MiB。',true);return;}input.value=await f.text();U.say(feedback,'已导入草稿，尚未保存。');}});bar.append(file);section.append(bar);
    return{section,input,load,clear(){baseline=null;input.value='';},get loaded(){return baseline!==null;},get dirty(){return baseline!==null&&input.value!==baseline;}};
  }
  const plugins=editor('tools/plugins','插件源代码','与 2333 共用插件存储。支持导入安装、编辑更新、导出；删除一个插件时只删除其 START/END 标记内的完整块。','plugins');
  const startup=editor('tools/startup','开机脚本','保存会保留最近一次 rc.local.bak，不创建日期堆叠备份。','startup');
  startup.section.append(U.button('载入最近一次备份为草稿',async()=>{if(!await U.confirm('载入备份草稿？','会替换编辑区内容，尚不写入设备；请检查后再保存。'))return;try{const d=await U.request(base+'startup-backup');startup.input.value=d.source;}catch(e){alert(e.message);}}));
  U.makeForm({route:'tools/hardware',id:'u60-nfc',title:'NFC Wi-Fi 分享',description:'使用设备原 NFC 服务，保留当前设备参数。',endpoint:base+'nfc',fields:[U.choices('switch','NFC 分享',[['0','关闭'],['1','开启']])],body:(_,v)=>({switch:Number(v.switch)}),warning:'开启后，靠近设备的 NFC 终端可能取得设备提供的 Wi-Fi 连接信息。'});
  const hardware=U.panel('tools/hardware','u60-usb','USB 接口','显示实际 USB 状态。反向供电会消耗路由器电池。');
  const hs=U.status(hardware),ht=U.el('pre','');hardware.append(ht);
  async function hardwareRead(){try{ht.textContent=JSON.stringify(await U.request('/api/usb/status'),null,2);}catch(e){U.say(hs,e.message,true);}}
  const hb=U.el('div','form-actions');for(const [label,state]of [['开启 USB 反向供电',1],['关闭 USB 反向供电',0]])hb.append(U.button(label,async()=>{if(!await U.confirm(`${label}？`,'将改变 USB 供电方向，可能中断连接并消耗电池。'))return;await U.mutate(hs,async()=>{await U.request('/api/usb/powerbank',U.json('PUT',{state}));await hardwareRead();U.say(hs,'已提交，请核对 USB 状态。');});}));
  const adbLink=U.el('a','button','有线 / 无线 ADB 控制');adbLink.href='#dashboard/functions';hb.append(adbLink,U.button('读取 USB 状态',hardwareRead));hardware.append(hb);
  const scheduled=U.panel('tools/scheduler','u60-scheduled','设备定时任务','设备时区为北京时间。周期任务 days 使用 0–6 表示周一到周日；一次任务 at 为 Unix 秒。支持 CPU、直供、Wi-Fi、重启等设备 API 操作。');
  const sf=U.status(scheduled),jobsList=U.el('div',''),jobDraft=U.el('textarea','');jobDraft.rows=15;jobDraft.style.width='100%';jobDraft.setAttribute('aria-label','任务配置');let editing=null;
  function newJob(){editing=null;jobDraft.value=JSON.stringify({name:'每天定时重启',schedule:{type:'recurring',time:'03:30',days:[0,1,2,3,4,5,6]},action:{method:'POST',path:'/api/device/reboot'},restore:null},null,2);}
  async function loadJobs(){try{const jobs=await U.request('/api/scheduler/jobs');jobsList.replaceChildren();if(!jobs.length)jobsList.append(U.el('p','','暂无定时任务。'));
    for(const job of jobs){const card=U.el('section','u60-adb-card');card.append(U.el('h3','',`${job.name} · ${job.enabled?'已启用':'已停用'}`),U.el('pre','',JSON.stringify({schedule:job.schedule,action:job.action,last_run:job.last_run,last_status:job.last_status,last_error:job.last_error},null,2)));
      const bar=U.el('div','form-actions');bar.append(U.button('编辑',()=>{editing=job.id;jobDraft.value=JSON.stringify(job,null,2);jobDraft.focus();}),U.button(job.enabled?'停用':'启用',async()=>{if(!await U.confirm('更改任务启用状态？',job.name))return;await U.mutate(sf,async()=>{await U.request('/api/scheduler/jobs/toggle',U.json('PUT',{id:job.id,enabled:!job.enabled}));await loadJobs();});}),U.button('删除',async()=>{if(!await U.confirm('删除此任务？',JSON.stringify(job,null,2),{label:'删除任务',destructive:true}))return;await U.mutate(sf,async()=>{await U.request('/api/scheduler/jobs',U.json('DELETE',{id:job.id}));await loadJobs();});}));card.append(bar);jobsList.append(card);}
  }catch(e){U.say(sf,e.message,true);}}
  const sb=U.el('div','form-actions');sb.append(U.button('新建任务草稿',newJob),U.button('保存任务',async()=>{let v;try{v=JSON.parse(jobDraft.value);}catch(e){U.say(sf,`JSON 无效：${e.message}`,true);return;}
    const body={name:v.name,schedule:v.schedule,action:v.action,restore:v.restore??null,...(editing!==null?{id:editing,enabled:v.enabled!==false}:{})};
    if(!await U.confirm('保存设备定时任务？',JSON.stringify(body,null,2)))return;
    await U.mutate(sf,async()=>{await U.request('/api/scheduler/jobs',U.json(editing===null?'POST':'PUT',body));await loadJobs();U.say(sf,'任务已保存。');});
  }),U.button('重新读取任务',loadJobs));scheduled.append(jobsList,jobDraft,sb);newJob();
  const lan=U.panel('tools/lan-test','u60-lan-test','内网测速','仅在浏览器与路由器之间传输 8 MiB 测试数据，不使用蜂窝流量。连接路径包含远程代理时，结果反映实际路径。');
  const lf=U.status(lan);let transfer=null;
  for(const [label,direction]of [['下载测速','download'],['上传测速','upload']])lan.append(U.button(label,async()=>{if(transfer)return;transfer=new AbortController();U.say(lf,'测速中…');try{const d=await C.lanTransfer(direction,transfer.signal);U.say(lf,`${label}：${d.mbps.toFixed(2)} Mbps · ${(d.bytes/1048576).toFixed(1)} MiB · ${d.seconds.toFixed(2)} 秒`);}catch(e){U.say(lf,e.name==='AbortError'?'已取消。':e.message,true);}finally{transfer=null;}}));lan.append(U.button('取消测速',()=>transfer?.abort()));
  const inventory=U.el('div','');plugins.section.prepend(inventory);
  const readPlugins=plugins.load;plugins.load=async()=>{await readPlugins();inventory.replaceChildren();const source=plugins.input.value;const blocks=[...source.matchAll(/<!--\s*\[KANO_PLUGIN_START\]\s*([^\n]*?)\s*-->[\s\S]*?<!--\s*\[KANO_PLUGIN_END\][^\n]*?-->/g)];inventory.append(U.el('h3','','已安装页面插件'));for(const block of blocks){const row=U.el('div','form-actions');row.append(U.el('strong','',block[1]),U.button('移除到草稿',async()=>{if(!await U.confirm(`移除 ${block[1]}？`,'仅从编辑草稿移除这一插件块；点击保存后才影响备用后台。'))return;plugins.input.value=plugins.input.value.replace(block[0],'');}));inventory.append(row);}if(!blocks.length)inventory.append(U.el('p','','没有识别到完整插件块；请检查源代码。'));};
  const install=U.el('input');install.type='file';install.setAttribute('aria-label','追加安装插件文件');install.addEventListener('change',async()=>{const f=install.files?.[0];if(!f)return;if(!plugins.loaded){alert('请先读取当前插件内容。');return;}if(f.size>1024*1024){alert('单个插件文件超过1 MiB。');return;}plugins.input.value+='\n'+await f.text();});plugins.section.append(U.el('label','','追加插件文件（加入草稿后检查并保存）'),install);
  let timer,reading=false;
  async function live(){if(reading||document.hidden||C.locked)return;const key=OpenU60Navigation.current.key;reading=true;try{
    if(key==='tools/performance'){const d=await U.request(base+'cpu');const thermal=await U.request('/api/device/thermal').catch(()=>null);cpuText.textContent=(Number.isFinite(thermal?.cpuss_temp)?`CPU 温度：${thermal.cpuss_temp.toFixed(1)} °C\n\n`:'')+d.cores.map(p=>`${p.name} · ${p.governor} · ${(Number(p.frequency_khz)/1000).toFixed(0)} MHz`).join('\n\n');}
    if(key==='tools/power'){const d=await U.request(base+'battery');powerText.textContent=`监控程序：${d.monitor_running?'运行中':'未确认运行，请检查'}\nUSB 输入：${d.input_online==='1'?'在线':'离线'}\nADSP 状态：${d.adsp_state}\n限流开关：${d.restrict_chg}\n当前限流节点：${d.restrict_cur} µA\n电池电流：${d.battery_current_ua} µA\n电池温度：${d.battery_temp!==''&&Number.isFinite(Number(d.battery_temp))?(Number(d.battery_temp)/10).toFixed(1)+' °C':'未上报'}`;}
  }catch(e){(key==='tools/power'?powerText:cpuText).textContent=e.message;}finally{reading=false;}}
  let activeRoute=''; function activate(){const key=OpenU60Navigation.current.key;if(C.locked||!C.connected||activeRoute===key)return;activeRoute=key;clearInterval(timer);live();if(['tools/performance','tools/power'].includes(key))timer=setInterval(live,5000);if(key==='tools/wifi-power')loadWifi();if(key==='tools/plugins'&&!plugins.loaded)plugins.load();if(key==='tools/startup'&&!startup.loaded)startup.load();if(key==='tools/hardware')hardwareRead();if(key==='tools/scheduler')loadJobs();if(key!=='tools/lan-test')transfer?.abort();} window.addEventListener('dashboard:navigate',()=>{activeRoute='';clearInterval(timer);activate();});window.addEventListener('dashboard:readings',activate);activate();
  window.addEventListener('dashboard:locked',()=>{clearInterval(timer);cpuText.textContent=powerText.textContent=ws.textContent='';plugins.clear();startup.clear();activeRoute='';});
  window.addEventListener('beforeunload',event=>{if(plugins.dirty||startup.dirty){event.preventDefault();event.returnValue='';}});
})();
