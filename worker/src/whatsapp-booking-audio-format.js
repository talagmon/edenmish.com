// Bounded in-Worker media parsing. Opus is remuxed losslessly into WebM; no
// transcoding service, subprocess, network or trusting a claimed file duration.
export const AUDIO_LIMITS=Object.freeze({bytes:2*1024*1024,seconds:60,calls:6,micros:5000,windowMs:15*60*1000});
const bad=()=>{throw new Error('unsupported_audio');};
const ascii=(bytes,start,length)=>String.fromCharCode(...bytes.subarray(start,start+length));
const join=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
const uint=(n,width=1)=>{while(n>=2**(8*width))width++;const out=new Uint8Array(width);for(let i=width-1;i>=0;i--){out[i]=n%256;n=Math.floor(n/256);}return out;};
const vint=n=>{let width=1;while(n>=2**(7*width)-1)width++;const out=uint(n,width);out[0]|=1<<(8-width);return out;};
const element=(id,data)=>join([uint(id),vint(data.length),data]);
const str=value=>new TextEncoder().encode(value);
const number=(id,n)=>element(id,uint(n));
const float=(id,n)=>{const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,n);return element(id,b);};
function opusPacketSamples(packet) {
 if(!packet.length)bad();const toc=packet[0],config=toc>>3,code=toc&3;
 const frame=config<12?[480,960,1920,2880][config&3]:config<16?[480,960][config&1]:[120,240,480,960][config&3];
 const count=code===0?1:code<3?2:packet.length>1?packet[1]&63:0;
 if(!count||frame*count>5760)bad();return frame*count;
}
function oggCRC(page) {
 let crc=0;
 for(let i=0;i<page.length;i++) {crc^=(i>=22&&i<26?0:page[i])<<24;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&0x80000000)?0x04c11db7:0))>>>0;}
 return crc;
}
export function remuxOpus(bytes) {
 let pos=0,serial=null,seq=0,ended=false,pending=[],pendingSize=0;const packets=[];
 while(pos<bytes.length){
  if(ended||pos+27>bytes.length||ascii(bytes,pos,4)!=='OggS'||bytes[pos+4]!==0)bad();
  const view=new DataView(bytes.buffer,bytes.byteOffset+pos);const flags=bytes[pos+5],n=bytes[pos+26];
  if(flags&~7||pos+27+n>bytes.length||!!(flags&1)!==!!pendingSize)bad();
  if(serial===null){if(!(flags&2))bad();serial=view.getUint32(14,true);}else if(flags&2)bad();
  if(view.getUint32(14,true)!==serial||view.getUint32(18,true)!==seq++)bad();
  const laces=bytes.subarray(pos+27,pos+27+n),size=laces.reduce((a,b)=>a+b,0),end=pos+27+n+size;
  if(end>bytes.length||oggCRC(bytes.subarray(pos,end))!==view.getUint32(22,true))bad();
  let offset=pos+27+n;
  for(const length of laces){pending.push(bytes.subarray(offset,offset+length));pendingSize+=length;offset+=length;if(pendingSize>65536)bad();
   if(length<255){packets.push(join(pending));pending=[];pendingSize=0;}
  }
  ended=!!(flags&4);pos=end;
 }
 if(!ended||pendingSize||packets.length<3||ascii(packets[0],0,8)!=='OpusHead'||ascii(packets[1],0,8)!=='OpusTags')bad();
 const head=packets.shift();packets.shift();
 if(head.length!==19||head[8]!==1||![1,2].includes(head[9])||head[18]!==0)bad();
 const preSkip=new DataView(head.buffer,head.byteOffset).getUint16(10,true);
 let samples=0;const clusters=[];
 for(const p of packets){const time=Math.floor(samples/48);samples+=opusPacketSamples(p);if(samples/48000>AUDIO_LIMITS.seconds+0.12)bad();
  clusters.push(element(0x1f43b675,join([number(0xe7,time),element(0xa3,join([new Uint8Array([0x81,0,0,0x80]),p]))])));
 }
 // Reserve by decoded packets, including priming. No duration from untrusted granules.
 const seconds=samples/48000;if(seconds<=0||seconds>AUDIO_LIMITS.seconds)bad();
 const header=element(0x1a45dfa3,join([number(0x4286,1),number(0x42f7,1),number(0x42f2,4),number(0x42f3,8),element(0x4282,str('webm')),number(0x4287,4),number(0x4285,2)]));
 const info=element(0x1549a966,join([number(0x2ad7b1,1000000),element(0x4d80,str('EdenMish')),element(0x5741,str('EdenMish')),float(0x4489,seconds*1000)]));
 const track=element(0x1654ae6b,element(0xae,join([number(0xd7,1),number(0x73c5,1),number(0x83,2),element(0x86,str('A_OPUS')),element(0x63a2,head),number(0x56aa,Math.round(preSkip/48000*1e9)),number(0x56bb,80000000),element(0xe1,join([float(0xb5,48000),number(0x9f,head[9])]))])));
 return {bytes:join([header,element(0x18538067,join([info,track,...clusters]))]),mime:'audio/webm',extension:'webm',seconds};
}
function wavDuration(bytes){
 if(bytes.length<44||ascii(bytes,0,4)!=='RIFF'||ascii(bytes,8,4)!=='WAVE')bad();
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);if(v.getUint32(4,true)+8!==bytes.length)bad();
 let format=null,data=0;
 for(let p=12;p+8<=bytes.length;){const id=ascii(bytes,p,4),size=v.getUint32(p+4,true);if(p+8+size>bytes.length)bad();
  if(id==='fmt '){if(format||size<16)bad();const code=v.getUint16(p+8,true),channels=v.getUint16(p+10,true),rate=v.getUint32(p+12,true),bytesPerSecond=v.getUint32(p+16,true),align=v.getUint16(p+20,true),bits=v.getUint16(p+22,true);
   if(code!==1||![1,2].includes(channels)||rate<8000||rate>48000||![8,16,24,32].includes(bits)||align!==channels*bits/8||bytesPerSecond!==rate*align)bad();format={bytesPerSecond,align};}
  if(id==='data'){if(data||!size)bad();data=size;}
  p+=8+size+(size%2);
 }
 if(!format||!data||data%format.align)bad();return data/format.bytesPerSecond;
}
function mp3Duration(bytes){
 let p=0,seconds=0,frames=0;
 if(ascii(bytes,0,3)==='ID3'){if(bytes.length<10||[6,7,8,9].some(i=>bytes[i]&128))bad();p=10+bytes[6]*2097152+bytes[7]*16384+bytes[8]*128+bytes[9]+(bytes[5]&16?10:0);}
 while(p<bytes.length){if(bytes.length-p===128&&ascii(bytes,p,3)==='TAG'){p+=128;break;}
  if(p+4>bytes.length||bytes[p]!==255||(bytes[p+1]&224)!==224)bad();
  const version=(bytes[p+1]>>3)&3,layer=(bytes[p+1]>>1)&3,bi=bytes[p+2]>>4,ri=(bytes[p+2]>>2)&3,pad=(bytes[p+2]>>1)&1;
  if(version===1||layer!==1||bi===0||bi===15||ri===3)bad();
  const rate=[44100,48000,32000][ri]/(version===3?1:version===2?2:4),kbps=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bi];
  const length=Math.floor((version===3?144:72)*kbps*1000/rate)+pad;if(p+length>bytes.length)bad();
  seconds+=(version===3?1152:576)/rate;frames++;p+=length;if(seconds>AUDIO_LIMITS.seconds)bad();
 }
 if(!frames||p!==bytes.length)bad();return seconds;
}
export function prepareBookingAudio(bytes,mime) {
 if(!(bytes instanceof Uint8Array)||bytes.length>AUDIO_LIMITS.bytes||!bytes.length)bad();
 const type=mime.toLowerCase().split(';')[0].trim();
 if(['audio/ogg','application/ogg'].includes(type))return remuxOpus(bytes);
 const seconds=['audio/wav','audio/x-wav','audio/wave'].includes(type)?wavDuration(bytes):['audio/mpeg','audio/mp3'].includes(type)?mp3Duration(bytes):bad();
 if(!(seconds>0&&seconds<=AUDIO_LIMITS.seconds))bad();
 return {bytes,mime:type==='audio/mpeg'||type==='audio/mp3'?'audio/mpeg':'audio/wav',extension:type==='audio/mpeg'||type==='audio/mp3'?'mp3':'wav',seconds};
}
