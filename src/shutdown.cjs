'use strict';
// Cleanup is best-effort; app.exit guarantees an installer can replace the EXE.
async function closeWithDeadline(close, ms=2500){
 let timer; try{return await Promise.race([Promise.resolve().then(close).then(()=> 'closed',()=> 'error'), new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),ms);})]);}finally{clearTimeout(timer);}
}
module.exports={closeWithDeadline};
