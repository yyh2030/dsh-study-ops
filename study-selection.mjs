import { loadStudyContext } from './study-context.mjs'

// Each installed package loads its own copy; the Symbol shares one registry in
// the Host process. It stores only local configuration callbacks, no study data.
const KEY = Symbol.for('dsh.research.study-selection.v1')
const host = globalThis[KEY] || (globalThis[KEY] = new Map())
const error = (message, code='conflict') => Object.assign(new Error(message), {code})
export function researchSelection(scope = process.env.DSH_PROFILE_DIR || 'default') {
  if (!host.has(scope)) host.set(scope, { participants: new Map(), changing: false, revision: 0 })
  const state = host.get(scope)
  return {
    register(name, { prepare, current }) {
      const token=Symbol(name);state.participants.set(name,{token,prepare,current})
      return ()=>{if(state.participants.get(name)?.token===token)state.participants.delete(name)}
    },
    status() {
      const plugins = [...state.participants].map(([name,p])=>({name,study:p.current()}))
      return {revision:state.revision,changing:state.changing,plugins,consistent:new Set(plugins.map(p=>`${p.study.id}|${p.study.dataRoot}`)).size<=1}
    },
    /** Prepare is synchronous/read-only and returns {commit, rollback} callbacks.
     * Reject when busy. Commit only assigns a validated context and clears cache.
     * Rollback restores the old in-memory context if another commit fails.
     */
    connect(studyPath) {
      if(state.changing)throw error('正在切换研究，请稍后重试')
      loadStudyContext({studyPath}) // all plugins must use the same valid explicit file
      state.changing=true
      try{
        const prepared=[]
        for(const [name,p]of state.participants){
          const transaction=p.prepare(studyPath)
          if(!transaction||typeof transaction.commit!=='function'||typeof transaction.rollback!=='function'||typeof transaction.then==='function')throw error(`插件${name}未提供同步切换准备`)
          prepared.push(transaction)
        }
        const committed=[]
        try{for(const transaction of prepared){committed.push(transaction);transaction.commit()}}
        catch(failure){for(const transaction of committed.reverse())transaction.rollback();throw failure}
        state.revision++
        return this.status()
      }finally{state.changing=false}
    }
  }
}
