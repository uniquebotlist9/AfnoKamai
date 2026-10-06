const fs=require("fs");
function scan(f){
  const s=fs.readFileSync(f,"utf8");
  let d=0,i=0,line=1,st=[],mode=null,tpl=[];
  while(i<s.length){
    const c=s[i],n=s[i+1];
    if(c==="\n")line++;
    if(mode==="line"){ if(c==="\n")mode=null; i++; continue;}
    if(mode==="block"){ if(c==="*"&&n==="/"){mode=null;i+=2;continue;} i++; continue;}
    if(mode==="sq"){ if(c==="\\"){i+=2;continue;} if(c==="'")mode=null; i++; continue;}
    if(mode==="dq"){ if(c==="\\"){i+=2;continue;} if(c==='"')mode=null; i++; continue;}
    if(mode==="tpl"){ if(c==="\\"){i+=2;continue;} if(c==="`"){mode=null;i++;continue;}
      if(c==="$"&&n==="{"){ st.push(["{",line,"tpl"]); mode=null; i+=2; d++; continue;} i++; continue;}
    if(c==="/"&&n==="/"){mode="line";i+=2;continue;}
    if(c==="/"&&n==="*"){mode="block";i+=2;continue;}
    if(c==="'"){mode="sq";i++;continue;}
    if(c==='"'){mode="dq";i++;continue;}
    if(c==="`"){mode="tpl";i++;continue;}
    if(c==="{"||c==="("||c==="["){st.push([c,line,""]);d++;}
    else if(c==="}"||c===")"||c==="]"){
      const m={"}":"{",")":"(","]":"["}[c];
      const top=st.pop(); d--;
      if(!top||top[0]!==m){ console.log(f+": MISMATCH "+c+" at line "+line+" (expected close of "+(top?top[0]:"none")+" opened line "+(top?top[1]:"-")+")"); return; }
      if(top&&top[2]==="tpl")mode="tpl";
    }
    i++;
  }
  if(st.length) console.log(f+": UNCLOSED "+st.map(x=>x[0]+"@"+x[1]).join(", "));
  else if(d!==0) console.log(f+": depth "+d);
  else console.log(f+": balanced OK");
}
process.argv.slice(2).forEach(scan);
