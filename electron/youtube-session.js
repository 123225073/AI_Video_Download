// Keep the official YouTube sign-in chain in the same browser session.
// This does not supply credentials, accept challenges or read session storage.
export function youtubeOfficialNavigation(value) {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port)return {allowed:false};
    if(['www.youtube.com','youtube.com','m.youtube.com'].includes(u.hostname))return {allowed:true,authentication:false};
    const authentication=u.hostname==='accounts.google.com'&&/^\/(?:ServiceLogin|AccountChooser|InteractiveLogin)(?:\/|$)/.test(u.pathname)
      ||u.hostname==='accounts.google.com'&&/^\/(?:v3\/)?signin(?:\/|$)/.test(u.pathname)
      ||u.hostname==='accounts.youtube.com'&&/^\/accounts\/SetSID\/?$/.test(u.pathname)
      ||u.hostname==='consent.youtube.com'&&/^\/m\/?$/.test(u.pathname);
    return authentication?{allowed:true,authentication:true}:{allowed:false};
  } catch {
    return {allowed:false};
  }
}

// Called only when the user resumes collection after using the official login
// window. It never reads an authentication page or a different video's comments.
export function youtubeCommentContext(value,sourceURL) {
  try {
    const videoId=u=>u.pathname.replace(/\/$/,'')==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/shorts\/([\w-]{11})\/?$/)?.[1];
    const source=new URL(sourceURL),sourcePage=youtubeOfficialNavigation(source.href),id=videoId(source);
    if(!sourcePage.allowed||sourcePage.authentication||!id||!/^[\w-]{11}$/.test(id))return {action:'blocked'};
    const current=new URL(value),currentPage=youtubeOfficialNavigation(current.href);
    if(!currentPage.allowed)return {action:'blocked'};
    const target='https://www.youtube.com/watch?v='+encodeURIComponent(id);
    if(currentPage.authentication||current.pathname==='/'||current.hostname==='m.youtube.com'&&videoId(current)===id)return {action:'restore',url:target};
    return videoId(current)===id?{action:'read'}:{action:'blocked'};
  } catch {
    return {action:'blocked'};
  }
}
