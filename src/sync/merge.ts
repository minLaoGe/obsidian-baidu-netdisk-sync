/** Two-way line comparison: no historical base content is available. */
export function mergeText(local: string, remote: string): { diff: string; merged: string } {
  if (local === remote) return {diff: local.split("\n").map(l=>"  "+l).join("\n"),merged:local};
  const a=local.split("\n"), b=remote.split("\n");
  const pairs: [number,number][]=[];
  // Bound memory for large notes; retain common prefix/suffix in the fallback.
  if (a.length*b.length <= 1000000) {
    const rows=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));
    for(let i=a.length-1;i>=0;i--) for(let j=b.length-1;j>=0;j--)
      rows[i][j]=a[i]===b[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);
    let i=0,j=0;
    while(i<a.length&&j<b.length) {if(a[i]===b[j]) {pairs.push([i++,j++]);} else if(rows[i+1][j]>=rows[i][j+1]) i++; else j++;}
  } else {
    let i=0;while(i<a.length&&i<b.length&&a[i]===b[i]) {pairs.push([i,i]);i++;}
    let x=a.length-1,y=b.length-1;const tail:[number,number][]=[];
    while(x>=i&&y>=i&&a[x]===b[y]) tail.push([x--,y--]);pairs.push(...tail.reverse());
  }
  const diff:string[]=[], merged:string[]=[];let ai=0,bi=0;
  for(const [i,j] of [...pairs,[a.length,b.length]]) {
    const left=a.slice(ai,i),right=b.slice(bi,j);
    if(left.length||right.length) {
      diff.push(...left.map(l=>"- "+l),...right.map(l=>"+ "+l));
      merged.push("<<<<<<< LOCAL",...left,"=======",...right,">>>>>>> REMOTE");
    }
    if(i<a.length) {diff.push("  "+a[i]);merged.push(a[i]);}
    ai=i+1;bi=j+1;
  }
  return {diff:diff.join("\n"),merged:merged.join("\n")};
}
export function hasConflictMarkers(text:string):boolean {
  return /^(?:<{7} LOCAL|={7}|>{7} REMOTE)\r?$/m.test(text);
}
