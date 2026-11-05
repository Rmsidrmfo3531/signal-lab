/** TradFi has no validated replacement contract/quote provider.
 * This module contains no network clients or order links. Historical records
 * stay in the shared paper ledger and are never repriced from invented quotes.
 */
export const TRADFI_DISABLED_REASON='검증된 TradFi 상장·계약·실행 시세 공급자가 없어 신규 분석과 자동 모의 진입을 비활성화했습니다. 기존 PNL·포지션·거래 기록은 보존됩니다.';
export function tradfiAvailability(){
 return {status:'disabled',enabled:false,reasonCode:'TRADFI_PROVIDER_UNAVAILABLE',reason:TRADFI_DISABLED_REASON,
  provider:null,updatedAt:0,swaps:[],patterns:[],feedStatus:'disabled',feedUpdatedAt:0,
  feedError:TRADFI_DISABLED_REASON,scanInProgress:false,feedScanned:0,scanIntervalMinutes:null,
  newSignalsEnabled:false,paperEntryEnabled:false,positionTracking:'PAUSED_NO_VALIDATED_QUOTES'};
}
export function tradfiQuoteVerdict(){return {eligible:false,reasons:[TRADFI_DISABLED_REASON],ageSeconds:null}}
