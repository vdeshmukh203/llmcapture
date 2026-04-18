import { useState, useCallback, useRef } from "react";

const C = {
  bg:"#0f172a",sur:"#1e293b",sur2:"#0d1b2e",
  green:"#10b981",gDim:"#064e3b",gTxt:"#6ee7b7",
  red:"#ef4444",rDim:"#450a0a",rTxt:"#fca5a5",
  amber:"#f59e0b",aDim:"#2d1a00",aTxt:"#fcd34d",
  blue:"#60a5fa",bDim:"#1e3a5f",
  txt:"#f1f5f9",mut:"#94a3b8",dim:"#475569",
  brd:"#1e293b",brd2:"#334155",
  mono:`"Cascadia Code","Fira Code",Consolas,monospace`,
  sans:"-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
};

// ── Crypto Chain (exact mirror of crypto.js) ──────────────────────────────
const EKO=["turn","chainPosition","timestamp","status","role","renderedText","errorDetail","rawInput","previousHash","text","capturedAt","source","submittedAt"];
const SKO=["sessionId","platform","startedAt","url","threadKey"];

async function sha256(s){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
function nc(v,m){
  if(v===undefined)return m==="strict"?null:undefined;
  if(v===null)return null;
  if(typeof v==="number")return v;
  if(typeof v==="string"){
    if(m==="strict"){const s=v.trim();if(!s)return null;if(/^-?\d+$/.test(s)){const n=Number(s);return isFinite(n)?n:s;}return s;}
    return v;
  }
  return String(v);
}
function nt(v,m){
  if(v===undefined)return m==="strict"?null:undefined;
  if(v===null)return null;
  if(typeof v==="string"){if(m==="strict"){const s=v.trim();return s||null;}return v;}
  if(v instanceof Date)return v.toISOString();
  if(typeof v==="number")return new Date(v).toISOString();
  return String(v);
}
function ns(v,m,o={}){
  if(v===undefined)return m==="strict"?null:undefined;
  if(v===null)return null;
  const s=typeof v==="string"?v:String(v);
  if(o.nullIfEmpty&&!s)return null;
  return s;
}
function ned(v,m){
  if(v===undefined)return m==="strict"?null:undefined;
  if(!v)return null;
  return typeof v==="string"?v:String(v);
}
function nri(ri,m){
  if(!ri||typeof ri!=="object")return null;
  if(m==="legacy")return{text:ri.text,capturedAt:ri.capturedAt,source:ri.source,submittedAt:ri.submittedAt!==undefined?ri.submittedAt:null};
  return{
    text:ns(ri.text,m,{allowEmpty:true}),capturedAt:nt(ri.capturedAt,m),
    source:ns(ri.source,m,{allowEmpty:true}),
    submittedAt:(ri.submittedAt!==undefined&&ri.submittedAt!==null)?nt(ri.submittedAt,m):null
  };
}
function canonical(e,prev,m){
  const p=m==="legacy"?prev:(typeof prev==="string"&&prev.length?prev:"GENESIS");
  return{
    turn:nc(e.turn,m),chainPosition:nc(e.chainPosition,m),timestamp:nt(e.timestamp,m),
    status:ns(e.status,m,{allowEmpty:true}),role:ns(e.role,m,{allowEmpty:true}),
    renderedText:ns(e.renderedText,m,{allowEmpty:true}),errorDetail:ned(e.errorDetail,m),
    rawInput:nri(e.rawInput,m),previousHash:p
  };
}
async function entryHash(e,prev,m){return sha256(JSON.stringify(canonical(e,prev,m),EKO));}

async function verifyChain(entries){
  if(!Array.isArray(entries))return{valid:false,results:[]};
  const results=[];let prev="GENESIS";
  for(let i=0;i<entries.length;i++){
    const e=entries[i];
    const actual=e?.hash??null;
    const prevMatch=(e?.previousHash||"GENESIS")===prev;
    let expected=null,hashMatch=false,valid=false,mode="strict",err;
    try{
      expected=await entryHash(e,prev,"strict");
      hashMatch=expected===actual;valid=hashMatch&&prevMatch;
      if(!valid){
        const leg=await entryHash(e,prev,"legacy");
        if(leg===actual&&prevMatch){expected=leg;hashMatch=true;valid=true;mode="legacy";}
      }
    }catch(ex){err=String(ex);valid=false;}
    results.push({i,turn:e?.turn,cp:e?.chainPosition,role:e?.role,text:e?.renderedText||"",
      rawInput:e?.rawInput||null,ts:e?.timestamp,status:e?.status,storedPrev:e?.previousHash,
      valid,prevMatch,hashMatch,expected,actual,mode,...(err?{err}:{})});
    prev=actual;
  }
  return{valid:results.every(r=>r.valid),results};
}

async function verifyFP(session){
  if(!session?.fingerprint)return null;
  try{
    const obj={
      sessionId:ns(session.sessionId,"strict",{}),platform:ns(session.platform,"strict",{allowEmpty:true}),
      startedAt:nt(session.startedAt,"strict"),url:ns(session.url,"strict",{allowEmpty:true}),
      threadKey:ns(session.threadKey,"strict",{allowEmpty:true})
    };
    const computed=await sha256(JSON.stringify(obj,SKO));
    return{valid:computed===session.fingerprint,computed,stored:session.fingerprint};
  }catch(e){return{valid:false,err:String(e)};}
}

function parseLog(data){
  if(!data||typeof data!=="object")throw new Error("Not a valid JSON object.");
  if(data._format==="ai-chat-capture-study-manifest-v1")
    throw new Error("This is a study manifest — upload the forensic log (the file without '-manifest' in the name).");
  if(data._format?.startsWith("ai-chat-capture")&&data.entries&&data.session)
    return{session:data.session,entries:data.entries,events:data.events||[],exportedAt:data._exportedAt,fmt:data._format};
  if(data.session&&Array.isArray(data.entries))
    return{session:data.session,entries:data.entries,events:data.events||[],exportedAt:null,fmt:"unknown"};
  throw new Error("Unrecognized format. Expected 'session' and 'entries' fields in the JSON.");
}

// ── Small components ──────────────────────────────────────────────────────
function Chip({ok,label}){
  return(
    <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:10,fontWeight:500,
      padding:"2px 7px",borderRadius:10,background:ok?C.gDim:C.rDim,color:ok?C.gTxt:C.rTxt}}>
      {ok?"✓":"✗"} {label}
    </span>
  );
}
function Mono({children,color}){
  return <span style={{fontFamily:C.mono,fontSize:10,color:color||C.dim,wordBreak:"break-all",lineHeight:1.5}}>{children}</span>;
}
function SectionLabel({children}){
  return <div style={{fontSize:10,color:C.mut,textTransform:"uppercase",letterSpacing:".06em",marginBottom:10}}>{children}</div>;
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function Verifier(){
  const [phase,setPhase]=useState("idle");
  const [drag,setDrag]=useState(false);
  const [report,setReport]=useState(null);
  const [err,setErr]=useState("");
  const [exp,setExp]=useState(null);
  const fileRef=useRef();

  const process=useCallback(async(file)=>{
    setPhase("busy");setExp(null);
    try{
      const data=JSON.parse(await file.text());
      const parsed=parseLog(data);
      const[chain,fp]=await Promise.all([verifyChain(parsed.entries),verifyFP(parsed.session)]);
      setReport({...parsed,name:file.name,size:file.size,chain,fp});
      setPhase("done");
    }catch(e){setErr(e.message||String(e));setPhase("err");}
  },[]);

  const onDrop=e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)process(f);};
  const onFile=e=>{const f=e.target.files[0];if(f)process(f);};
  const reset=()=>{setPhase("idle");setReport(null);setErr("");setExp(null);if(fileRef.current)fileRef.current.value="";};

  // ── Drop zone ──
  if(phase==="idle"||phase==="err"){
    return(
      <div style={{background:C.bg,fontFamily:C.sans,minHeight:420,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 24px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:32}}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span style={{color:C.txt,fontSize:14,fontWeight:500}}>Chain Verifier</span>
          <span style={{color:C.dim,fontSize:11,background:C.sur,padding:"2px 8px",borderRadius:10,border:`0.5px solid ${C.brd2}`}}>AI Chat Capture</span>
        </div>

        {phase==="err"&&(
          <div style={{background:C.rDim,border:`1px solid ${C.red}`,borderRadius:8,padding:"10px 16px",marginBottom:20,maxWidth:440,textAlign:"center",width:"100%"}}>
            <span style={{color:C.rTxt,fontSize:13}}>{err}</span>
          </div>
        )}

        <div
          onDragOver={e=>{e.preventDefault();setDrag(true);}}
          onDragLeave={()=>setDrag(false)}
          onDrop={onDrop}
          onClick={()=>fileRef.current?.click()}
          style={{
            width:"100%",maxWidth:420,border:`2px dashed ${drag?C.green:C.brd2}`,
            borderRadius:12,padding:"52px 32px",textAlign:"center",cursor:"pointer",
            background:drag?"#0a1f18":C.sur2,transition:"all .15s",
          }}
        >
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={drag?C.green:C.dim} strokeWidth="1.5" style={{marginBottom:14}}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <p style={{color:drag?C.gTxt:C.txt,fontSize:15,fontWeight:500,marginBottom:6}}>
            {drag?"Release to verify":"Drop forensic log JSON"}
          </p>
          <p style={{color:C.mut,fontSize:13,marginBottom:12}}>or click to browse</p>
          <p style={{color:C.dim,fontSize:11}}>ai-chat-capture-v12 format · Processed entirely in-browser</p>
        </div>
        <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={onFile}/>
      </div>
    );
  }

  // ── Spinner ──
  if(phase==="busy"){
    return(
      <div style={{background:C.bg,fontFamily:C.sans,minHeight:420,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2" style={{animation:"spin .8s linear infinite"}}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <p style={{color:C.mut,fontSize:13}}>Computing chain hashes…</p>
      </div>
    );
  }

  // ── Report ──
  const{session,entries,events,name,size,chain,fp,fmt}=report;
  const ok=chain.valid;
  const fails=chain.results.filter(r=>!r.valid).length;
  const legacyN=chain.results.filter(r=>r.mode==="legacy").length;

  return(
    <div style={{background:C.bg,fontFamily:C.sans,color:C.txt}}>
      <div style={{maxWidth:860,margin:"0 auto",padding:"24px 20px 64px"}}>

        {/* Nav */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,paddingBottom:16,borderBottom:`0.5px solid ${C.brd}`}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span style={{fontSize:13,fontWeight:500}}>Chain Verifier</span>
          </div>
          <button onClick={reset} style={{background:"none",border:`0.5px solid ${C.dim}`,color:C.mut,borderRadius:6,padding:"5px 14px",fontSize:12,cursor:"pointer"}}>← Verify another</button>
        </div>

        {/* Verdict banner */}
        <div style={{borderRadius:12,padding:"20px 22px",marginBottom:20,background:ok?C.gDim:C.rDim,border:`1px solid ${ok?C.green:C.red}`,display:"flex",alignItems:"flex-start",gap:16}}>
          <div style={{flexShrink:0,marginTop:2}}>
            {ok
              ?<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.gTxt} strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
              :<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.rTxt} strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
            }
          </div>
          <div>
            <div style={{fontSize:18,fontWeight:500,color:ok?C.gTxt:C.rTxt,marginBottom:4}}>
              {ok?"Chain intact — session verified":`Chain broken — ${fails} entr${fails===1?"y":"ies"} failed`}
            </div>
            <div style={{fontSize:13,color:ok?"#6ee7b7bb":"#fca5a5bb",lineHeight:1.5}}>
              {ok
                ?`All ${entries.length} entries hash correctly in sequence. This log has not been altered since capture.`
                :`${entries.length-fails} of ${entries.length} entries verify correctly. Tampered or corrupted entries are marked below.`}
            </div>
          </div>
        </div>

        {/* Stat cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:20}}>
          {[
            {l:"Platform",v:session.platform||"—"},
            {l:"Prompts",v:session.promptCount??entries.filter(e=>e.role==="user").length},
            {l:"Entries",v:session.entryCount??entries.length},
            {l:"Failed",v:fails,bad:fails>0},
            {l:"Session status",v:session.status||"—"},
          ].map(({l,v,bad})=>(
            <div key={l} style={{background:C.sur,border:`0.5px solid ${C.brd}`,borderRadius:8,padding:"12px 14px"}}>
              <div style={{fontSize:10,color:C.mut,textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>{l}</div>
              <div style={{fontSize:15,fontWeight:500,color:bad?C.rTxt:C.txt}}>{String(v)}</div>
            </div>
          ))}
        </div>

        {/* Session detail */}
        <div style={{background:C.sur,border:`0.5px solid ${C.brd}`,borderRadius:10,padding:"14px 16px",marginBottom:20}}>
          <SectionLabel>Session metadata</SectionLabel>
          {[
            ["Session ID",session.sessionId,"mono"],
            ["Thread key",session.threadKey,"mono"],
            ["Started",session.startedAt?new Date(session.startedAt).toLocaleString():"—"],
            ["Ended",session.endedAt?new Date(session.endedAt).toLocaleString():"—"],
            ["URL",session.url],
            ["Format",fmt],
            ["File",`${name} · ${(size/1024).toFixed(1)} KB`],
          ].map(([k,v,style])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"5px 0",borderBottom:`0.5px solid ${C.brd}`,gap:16}}>
              <span style={{fontSize:12,color:C.mut,flexShrink:0}}>{k}</span>
              <span style={{fontSize:style==="mono"?10:12,fontFamily:style==="mono"?C.mono:"inherit",color:C.txt,textAlign:"right",wordBreak:"break-all"}}>{v||"—"}</span>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",gap:16}}>
            <span style={{fontSize:12,color:C.mut,flexShrink:0}}>Fingerprint</span>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              {fp
                ?<><Mono color={C.dim}>{(session.fingerprint||"").slice(0,16)}…</Mono><Chip ok={fp.valid} label={fp.valid?"verified":"mismatch"}/></>
                :<span style={{fontSize:12,color:C.dim}}>Not present in log</span>
              }
            </div>
          </div>
        </div>

        {/* Warnings */}
        {(legacyN>0||session.lockReason)&&(
          <div style={{background:C.aDim,border:`0.5px solid #78350f`,borderRadius:8,padding:"10px 14px",marginBottom:20,fontSize:12,color:C.aTxt}}>
            {legacyN>0&&<div>⚠ {legacyN} entr{legacyN===1?"y":"ies"} verified using legacy canonicalization (pre-strict hash format). Chain is valid.</div>}
            {session.lockReason&&<div style={{marginTop:legacyN>0?4:0}}>Session was locked: {session.lockReason}</div>}
          </div>
        )}

        {/* Entry table */}
        <div style={{marginBottom:24}}>
          <SectionLabel>Entry chain · {entries.length} entries · click any row for full detail</SectionLabel>
          <div style={{border:`0.5px solid ${C.brd}`,borderRadius:10,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"40px 40px 70px 1fr 82px 82px 58px",padding:"7px 12px",background:C.sur2,fontSize:9,color:C.dim,textTransform:"uppercase",letterSpacing:".06em",gap:8,borderBottom:`0.5px solid ${C.brd}`}}>
              <span>#</span><span>Turn</span><span>Role</span><span>Content preview</span>
              <span style={{textAlign:"center"}}>Prev hash</span><span style={{textAlign:"center"}}>Hash</span><span>Mode</span>
            </div>
            <div style={{maxHeight:460,overflowY:"auto"}}>
              {chain.results.length===0&&(
                <div style={{padding:"24px",textAlign:"center",color:C.dim,fontSize:13}}>No entries in this session</div>
              )}
              {chain.results.map((r,i)=>{
                const isExp=exp===i;
                const bg=!r.valid?"#180a0a":i%2===0?C.sur2:"#0e1d2e";
                const bl=!r.valid?`3px solid ${C.red}`:r.mode==="legacy"?`3px solid ${C.amber}`:"3px solid transparent";
                const failReason=!r.prevMatch&&!r.hashMatch?"chain linkage + hash both broken":!r.prevMatch?"chain linkage broken":!r.hashMatch?"hash mismatch":"";
                return(
                  <div key={i}>
                    <div
                      onClick={()=>setExp(isExp?null:i)}
                      style={{display:"grid",gridTemplateColumns:"40px 40px 70px 1fr 82px 82px 58px",
                        padding:"7px 12px",gap:8,background:bg,borderLeft:bl,
                        borderBottom:`0.5px solid ${C.brd}`,cursor:"pointer"}}
                    >
                      <span style={{fontFamily:C.mono,fontSize:10,color:C.dim}}>{r.cp??i+1}</span>
                      <span style={{fontFamily:C.mono,fontSize:10,color:C.dim}}>{r.turn??i+1}</span>
                      <span style={{
                        fontSize:10,fontWeight:500,padding:"2px 5px",borderRadius:4,alignSelf:"center",textAlign:"center",
                        background:r.role==="user"?C.bDim:C.gDim,color:r.role==="user"?C.blue:C.gTxt,
                      }}>{r.role||"?"}</span>
                      <span style={{color:C.mut,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12}}>
                        {r.text.slice(0,90)}{r.text.length>90?"…":""}
                      </span>
                      <div style={{display:"flex",justifyContent:"center"}}><Chip ok={r.prevMatch} label={r.prevMatch?"ok":"broken"}/></div>
                      <div style={{display:"flex",justifyContent:"center"}}><Chip ok={r.hashMatch} label={r.hashMatch?"ok":"broken"}/></div>
                      <span style={{fontSize:10,color:r.mode==="legacy"?C.aTxt:C.dim,alignSelf:"center"}}>{r.mode}</span>
                    </div>

                    {isExp&&(
                      <div style={{background:"#090f18",padding:"14px 16px",borderLeft:bl,borderBottom:`0.5px solid ${C.brd}`,fontSize:12}}>
                        {!r.valid&&(
                          <div style={{background:C.rDim,border:`0.5px solid ${C.red}`,borderRadius:6,padding:"8px 12px",marginBottom:12}}>
                            <span style={{color:C.rTxt,fontWeight:500,fontSize:12}}>
                              Verification failed: {failReason}
                            </span>
                          </div>
                        )}

                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                          <div>
                            <div style={{fontSize:10,color:C.dim,textTransform:"uppercase",letterSpacing:".04em",marginBottom:5}}>Stored hash (in log)</div>
                            <Mono color={r.hashMatch?C.gTxt:C.rTxt}>{r.actual||"—"}</Mono>
                          </div>
                          <div>
                            <div style={{fontSize:10,color:C.dim,textTransform:"uppercase",letterSpacing:".04em",marginBottom:5}}>Computed hash (now)</div>
                            <Mono color={r.hashMatch?C.gTxt:C.aTxt}>{r.expected||"—"}</Mono>
                          </div>
                        </div>

                        <div style={{marginBottom:12}}>
                          <div style={{fontSize:10,color:C.dim,textTransform:"uppercase",letterSpacing:".04em",marginBottom:5}}>Previous hash reference (stored in this entry)</div>
                          <Mono color={r.prevMatch?C.gTxt:C.rTxt}>{r.storedPrev||"GENESIS"}</Mono>
                        </div>

                        <div style={{marginBottom:r.rawInput?12:0}}>
                          <div style={{fontSize:10,color:C.dim,textTransform:"uppercase",letterSpacing:".04em",marginBottom:5}}>Rendered text — what the AI received</div>
                          <div style={{color:C.mut,fontSize:12,lineHeight:1.5,whiteSpace:"pre-wrap",maxHeight:100,overflowY:"auto",background:C.sur2,padding:"8px 10px",borderRadius:6}}>{r.text||"—"}</div>
                        </div>

                        {r.rawInput&&(
                          <div style={{marginTop:12}}>
                            <div style={{fontSize:10,color:C.dim,textTransform:"uppercase",letterSpacing:".04em",marginBottom:5}}>Raw keystroke capture — what was actually typed</div>
                            <div style={{color:C.mut,fontSize:12,lineHeight:1.5,background:C.sur2,padding:"8px 10px",borderRadius:6,maxHeight:80,overflowY:"auto"}}>{r.rawInput.text||"—"}</div>
                            <div style={{fontSize:10,color:C.dim,marginTop:4}}>
                              captured: {r.rawInput.capturedAt||"—"} · source: {r.rawInput.source||"—"}
                              {r.rawInput.submittedAt&&<> · submitted: {r.rawInput.submittedAt}</>}
                            </div>
                          </div>
                        )}

                        <div style={{marginTop:10,fontSize:11,color:C.dim,borderTop:`0.5px solid ${C.brd}`,paddingTop:8}}>
                          timestamp: {r.ts||"—"} · entry status: {r.status||"—"} · canonicalization: {r.mode}
                          {r.err&&<span style={{color:C.rTxt}}> · compute error: {r.err}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Events log */}
        {events.length>0&&(
          <div style={{marginBottom:24}}>
            <SectionLabel>Session events · {events.length}</SectionLabel>
            <div style={{background:C.sur,border:`0.5px solid ${C.brd}`,borderRadius:10,overflow:"hidden",maxHeight:200,overflowY:"auto"}}>
              {events.map((ev,i)=>(
                <div key={i} style={{display:"flex",gap:10,padding:"7px 14px",borderBottom:`0.5px solid ${C.brd}`,fontSize:11,alignItems:"flex-start"}}>
                  <span style={{color:C.dim,fontFamily:C.mono,flexShrink:0,fontSize:10,marginTop:1}}>
                    {ev.timestamp?new Date(ev.timestamp).toLocaleTimeString():"—"}
                  </span>
                  <span style={{
                    flexShrink:0,fontSize:10,padding:"1px 7px",borderRadius:3,marginTop:1,
                    background:ev.level==="error"?C.rDim:ev.level==="warning"?C.aDim:C.sur2,
                    color:ev.level==="error"?C.rTxt:ev.level==="warning"?C.aTxt:C.dim,
                  }}>{ev.type}</span>
                  <span style={{color:C.mut}}>{ev.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{textAlign:"center",paddingTop:20,borderTop:`0.5px solid ${C.brd}`}}>
          <p style={{fontSize:11,color:C.dim}}>Verification runs entirely in-browser · No data transmitted · Web Crypto API SHA-256</p>
        </div>

      </div>
    </div>
  );
}
