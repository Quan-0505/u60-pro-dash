'use strict';
(() => {
  const U=OpenU60UI;
  const section=U.panel('tools/catalog','u60-plugin-catalog','插件商店目录 · 只读','仅浏览插件信息，便于选择后续界面适配项目。这里没有插件安装、更新或执行操作。');
  const status=U.status(section);
  const toolbar=U.el('div','catalog-toolbar');
  const search=U.el('input');search.type='search';search.placeholder='搜索名称、作者、功能或型号';search.setAttribute('aria-label','搜索商店插件');
  const category=U.el('select');category.setAttribute('aria-label','按用途分组（整理）');
  const sort=U.el('select');sort.setAttribute('aria-label','目录排序');
  for(const [value,label]of [['original','原商店顺序'],['date','更新时间'],['name','插件名称']]){const o=U.el('option','',label);o.value=value;sort.append(o);}
  toolbar.append(search,category,sort);section.append(toolbar);
  const resultCount=U.el('p','section-subtitle');resultCount.setAttribute('role','status');
  const grid=U.el('div','catalog-grid');section.append(resultCount,grid);
  let catalog=null;
  const missing=U.el('p','','没有匹配的插件。可以清空搜索或更换分组。');missing.hidden=true;section.append(missing);
  function render(){
    if(!catalog)return;
    const query=search.value.trim().toLocaleLowerCase();
    const items=catalog.plugins.filter(p=>(!category.value||p.category===category.value)&&[p.name,p.author,p.description,p.compatibility,p.category].join(' ').toLocaleLowerCase().includes(query));
    if(sort.value==='name')items.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
    if(sort.value==='date')items.sort((a,b)=>Date.parse(b.updatedAt.replaceAll('/','-'))-Date.parse(a.updatedAt.replaceAll('/','-')));
    resultCount.textContent=`显示 ${items.length} / ${catalog.count} 个插件`;missing.hidden=items.length!==0;grid.replaceChildren();
    for(const p of items){
      const card=U.el('article','catalog-card');card.append(U.el('h3','',p.name),U.el('p','catalog-version',`${p.version} · ${p.category}`),U.el('p','section-subtitle',`作者：${p.author}`),U.el('p','catalog-compat',p.compatibility),U.el('p','catalog-description',p.description||'原商店未提供简介。'),U.el('p','section-subtitle',`商店更新时间：${p.updatedAt} · 下载统计：${p.downloads}`));grid.append(card);
    }
  }
  search.addEventListener('input',render);category.addEventListener('change',render);sort.addEventListener('change',render);
  const actions=U.el('div','form-actions');
  function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type})),a=U.el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const exportJSON=U.button('导出目录 JSON',()=>{if(catalog)download('U60-plugin-catalog.json',JSON.stringify(catalog,null,2),'application/json;charset=utf-8');});exportJSON.disabled=true;
  const exportCSV=U.button('导出插件清单 CSV',()=>{
    if(!catalog)return;
    const cell=value=>'"'+String(value??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
    const rows=[['名称','版本','作者','用途分组（整理）','适用范围（原商店标注）','简介','商店更新时间','下载统计'],...catalog.plugins.map(p=>[p.name,p.version,p.author,p.category,p.compatibility,p.description,p.updatedAt,p.downloads])];
    download('U60插件商店目录.csv','\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  });exportCSV.disabled=true;
  actions.append(U.button('清空筛选',()=>{search.value='';category.value='';render();}),exportJSON,exportCSV);section.append(actions);
  section.append(U.el('p','section-subtitle','目录为核对时的快照，用途分组为整理结果；名称、简介及适用范围来自原商店。没有运行这些插件，兼容性尚未逐项验证。'));
  let loading=false;
  async function load(){
    if(catalog||loading)return;loading=true;U.say(status,'正在读取目录信息…');
    try{
      const response=await fetch('/console/a/plugin-catalog.json',{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json();
      if(!Array.isArray(data.plugins)||data.count!==data.plugins.length||new Set(data.plugins.map(p=>p.id)).size!==data.count)throw new Error('目录数量或编号校验失败');
      catalog=data;category.replaceChildren();
      for(const label of ['全部用途',...[...new Set(catalog.plugins.map(p=>p.category))].sort((a,b)=>a.localeCompare(b,'zh-CN'))]){const o=U.el('option','',label);o.value=label==='全部用途'?'':label;category.append(o);}
      U.say(status,`核对日期：${catalog.observedOn} · 来源：${catalog.source} · ${catalog.count} 个插件 · 只读快照`);exportJSON.disabled=exportCSV.disabled=false;render();
    }catch(e){U.say(status,`目录读取失败：${e.message}`,true);}finally{loading=false;}
  }
  function activate(){if(OpenU60Navigation.current.key==='tools/catalog')load();}
  window.addEventListener('dashboard:navigate',activate);activate();
})();
